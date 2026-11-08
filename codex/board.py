#!/usr/bin/env python3
"""Serve a local, read-only Session Board for Codex."""

import argparse
import json
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from queue import Empty, Queue
from threading import Thread
from time import monotonic


class AppServer:
    def __init__(self):
        self.process = subprocess.Popen(
            ["codex", "app-server", "-c", "analytics.enabled=false"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", stderr=subprocess.DEVNULL,
        )
        self.replies = Queue()
        self.request_id = 0
        self.reader = Thread(target=self.read_replies, daemon=True)
        self.reader.start()

    def read_replies(self):
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                if "id" in message and "method" not in message:
                    self.replies.put(message)
        except ValueError:
            pass
        finally:
            self.replies.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.request_id += 1
        self.send({"id": self.request_id, "method": method, "params": params})
        deadline = monotonic() + 5
        while True:
            try:
                reply = self.replies.get(timeout=max(0, deadline - monotonic()))
            except Empty:
                raise RuntimeError("Codex App Server did not respond.") from None
            if reply is None:
                raise RuntimeError("Codex App Server disconnected.")
            if reply["id"] != self.request_id:
                continue
            if "error" in reply:
                raise RuntimeError(reply["error"]["message"])
            return reply["result"]

    def initialize(self):
        self.request("initialize", {"clientInfo": {
            "name": "session_board", "title": "Session Board", "version": "0.1.0",
        }})
        self.send({"method": "initialized"})

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.reader.join()
        self.process.stdin.close()
        self.process.stdout.close()


def list_threads(app):
    result = app.request("thread/list", {
        "limit": 100,
        "sortKey": "updated_at",
        "archived": False,
        "useStateDbOnly": True,
        "modelProviders": [],
        "sourceKinds": ["cli", "vscode", "appServer", "unknown"],
    })
    return [
        {key: thread.get(key) for key in ("id", "name", "preview", "cwd", "updatedAt")}
        for thread in result["data"]
    ]


def serve():
    page = Path(__file__).with_name("board.html").read_bytes()
    app = None

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def respond(self, status, content_type, body):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            nonlocal app
            # Keep private thread metadata on the board's own loopback origin.
            host = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != host or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403)
                return
            if self.path == "/":
                self.respond(200, "text/html; charset=utf-8", page)
                return
            if self.path != "/threads":
                self.send_error(404)
                return
            try:
                if app is None:
                    app = AppServer()
                    app.initialize()
                rows = list_threads(app)
            except (OSError, RuntimeError) as error:
                if app is not None:
                    app.close()
                    app = None
                status, payload = 502, {"error": str(error)}
            else:
                status, payload = 200, {"threads": rows}
            self.respond(status, "application/json", json.dumps(payload).encode("utf-8"))

        def log_message(self, *_args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        print(f"Open http://127.0.0.1:{server.server_port} in your browser.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            if app is not None:
                app.close()


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    serve()


if __name__ == "__main__":
    main()
