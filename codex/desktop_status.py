"""Read runtime status from the local Codex desktop thread stream."""

import json
import os
import socket
import stat
import struct
import time
from pathlib import Path
from uuid import uuid4


FOLLOW_LIMIT = 16
MAX_FRAME = 32 * 1024 * 1024
FOLLOW = "thread-stream-following-changed"
STREAM = "thread-stream-state-changed"


def classify(status):
    if not isinstance(status, dict):
        return None
    kind = status.get("type")
    if kind == "active":
        flags = status.get("activeFlags", [])
        if "waitingOnApproval" in flags:
            return "approval"
        if "waitingOnUserInput" in flags:
            return "input"
        return "working"
    return {"idle": "idle", "systemError": "error"}.get(kind)


class DesktopStatus:
    def __init__(self):
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
        self.path = home / "ipc" / "ipc.sock"
        self.connection = None
        self.client = None
        self.buffer = bytearray()
        self.following = set()
        self.states = {}
        self.retry_at = 0

    def close(self):
        if self.connection is not None:
            self.connection.close()
        self.connection = self.client = None
        self.buffer.clear()
        self.following.clear()
        self.states.clear()
        self.retry_at = time.monotonic() + 3

    def send(self, message):
        body = json.dumps(message).encode("utf-8")
        self.connection.sendall(struct.pack("<I", len(body)) + body)

    def connect(self):
        info = self.path.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise OSError("Desktop socket is unavailable")
        self.connection = socket.socket(socket.AF_UNIX)
        self.connection.settimeout(0.2)
        self.connection.connect(str(self.path))
        self.initialize_id = str(uuid4())
        self.initialize_deadline = time.monotonic() + 1
        self.send({
            "type": "request", "method": "initialize", "version": 0,
            "requestId": self.initialize_id, "params": {"clientType": "session-board"},
        })

    def follow(self, thread_id, enabled):
        self.send({
            "type": "broadcast", "method": FOLLOW, "version": 1,
            "sourceClientId": self.client,
            "params": {"hostId": "local", "conversationId": thread_id, "following": enabled},
        })

    def receive(self):
        deadline = time.monotonic() + 0.15
        while time.monotonic() < deadline:
            try:
                data = self.connection.recv(65536)
            except TimeoutError:
                return
            if not data:
                raise OSError("Desktop disconnected")
            self.buffer.extend(data)
            offset = 0
            while len(self.buffer) - offset >= 4:
                size = struct.unpack_from("<I", self.buffer, offset)[0]
                if size > MAX_FRAME:
                    raise ValueError("Desktop frame is too large")
                end = offset + 4 + size
                if end > len(self.buffer):
                    break
                self.handle(json.loads(self.buffer[offset + 4:end]))
                offset = end
            del self.buffer[:offset]

    def handle(self, message):
        if message.get("requestId") == self.initialize_id:
            self.client = message.get("result", {}).get("clientId")
            if self.client is None:
                raise ValueError("Desktop initialization failed")
            return
        method = message.get("method")
        params = message.get("params", {})
        if method == "client-status-changed" and params.get("status") == "disconnected":
            for thread_id, state in list(self.states.items()):
                if state[0] == params.get("clientId"):
                    del self.states[thread_id]
                    self.follow(thread_id, True)
            return
        if method != STREAM or params.get("hostId") != "local":
            return
        thread_id = params.get("conversationId")
        if thread_id not in self.following:
            return
        if message.get("version") != 11:
            raise ValueError("Unsupported desktop thread stream version")
        source = message.get("sourceClientId")
        change = params["change"]
        if change["type"] == "snapshot":
            status = classify(change["conversationState"].get("threadRuntimeStatus"))
        elif change["type"] == "patches" and thread_id in self.states:
            owner, revision, status = self.states[thread_id]
            if source != owner:
                return
            if revision != change.get("baseRevision"):
                self.resnapshot(thread_id)
                return
            for patch in change.get("patches", []):
                path = patch.get("path", [])
                if path == ["threadRuntimeStatus"]:
                    status = classify(patch.get("value"))
                elif path and path[0] == "threadRuntimeStatus":
                    self.resnapshot(thread_id)
                    return
        else:
            return
        self.states[thread_id] = (source, change["revision"], status)

    def resnapshot(self, thread_id):
        self.states.pop(thread_id, None)
        self.follow(thread_id, True)

    def update(self, threads):
        if self.connection is None and time.monotonic() < self.retry_at:
            return
        try:
            if self.connection is None:
                self.connect()
            self.receive()
            if self.client is None:
                if time.monotonic() >= self.initialize_deadline:
                    self.close()
                return
            # Keep working and waiting chats in view as other chats move up.
            live = {"working", "input", "approval"}
            recent = sorted(threads, key=lambda row: self.status(row["id"]) not in live)
            wanted = {row["id"] for row in recent[:FOLLOW_LIMIT]}
            for thread_id in self.following - wanted:
                self.follow(thread_id, False)
                self.states.pop(thread_id, None)
            for thread_id in wanted - self.following:
                self.follow(thread_id, True)
            self.following = wanted
            self.receive()
        except (OSError, ValueError, KeyError, TypeError):
            self.close()

    def status(self, thread_id):
        state = self.states.get(thread_id)
        return state[2] if state else None
