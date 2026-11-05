#!/usr/bin/env python3
"""Print every live Claude Code session on this machine as one JSON document.

Read-only. Sources:
  ~/.claude/sessions/<pid>.json        status the engine reports for each process
  ~/.claude/projects/*/<id>.jsonl      transcript, read from its end only
"""
import glob
import json
import os
import re
import time

HOME = os.path.expanduser("~")
SESSIONS = os.path.join(HOME, ".claude", "sessions")
PROJECTS = os.path.join(HOME, ".claude", "projects")
# Transcripts reach hundreds of MB, so only the end is ever read.
TAIL_BYTES = 1_500_000
RANK = {"needs-you": 0, "decision": 1, "running": 2, "subagent": 2, "thinking": 2, "polling": 3, "idle": 4}


def one_line(text, limit=220):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", str(text or ""))
    text = re.sub(r"\s+", " ", text.replace("**", "").replace("`", "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def is_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def find_transcript(session):
    session_id = session.get("sessionId")
    if not session_id:
        return None
    folder = re.sub(r"[^a-zA-Z0-9]", "-", session.get("cwd") or "")
    direct = os.path.join(PROJECTS, folder, session_id + ".jsonl")
    if os.path.exists(direct):
        return direct
    # A session that changed directory keeps its transcript where it started.
    found = glob.glob(os.path.join(PROJECTS, "*", session_id + ".jsonl"))
    return found[0] if found else None


def read_rows(path):
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - TAIL_BYTES))
        lines = handle.read().decode("utf-8", "ignore").splitlines()
    if size > TAIL_BYTES:
        lines = lines[1:]  # The first line is cut by the seek.
    for line in lines:
        if '"assistant"' not in line and '"user"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") in ("assistant", "user") and not row.get("isSidechain"):
            yield row


def describe_tool(name, tool_input):
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    short = name.split("__")[-1] if name.startswith("mcp__") else name
    if name == "Bash":
        return "Bash: " + one_line(tool_input.get("description") or tool_input.get("command"))
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        return name + ": " + os.path.basename(str(tool_input.get("file_path") or tool_input.get("notebook_path") or ""))
    if name == "Agent":
        return "Agent: " + one_line(tool_input.get("description"))
    if name == "AskUserQuestion":
        questions = tool_input.get("questions") or [{}]
        return "Asks: " + one_line(questions[0].get("question"))
    if name == "ScheduleWakeup":
        return "Sleeping: " + one_line(tool_input.get("reason"))
    if name == "Monitor":
        return "Monitor: " + one_line(tool_input.get("description") or tool_input.get("command"))
    return short


def read_activity(path):
    activity = {
        "pending": {}, "text": "", "thinking": "", "prompt": "", "recap": "",
        "ask": "", "steps": [], "step": -1, "lastTool": "", "lastToolInput": {},
    }
    if not path:
        return activity
    try:
        rows = list(read_rows(path))
    except OSError:
        return activity
    for row in rows:
        message = row.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict):
                apply_block(activity, row, block)
    return activity


def apply_block(activity, row, block):
    kind = block.get("type")
    if row["type"] == "user":
        if kind == "tool_result":
            activity["pending"].pop(block.get("tool_use_id"), None)
        elif kind == "text" and not row.get("isMeta"):
            text = one_line(block.get("text"))
            if text and not text.startswith("<"):
                activity["prompt"] = text
                # A new prompt answers whatever the last turn asked.
                activity.update(ask="", recap="", text="", thinking="", steps=[], step=-1)
        return
    if kind == "text":
        activity["text"] = one_line(block.get("text"))
    elif kind == "thinking":
        activity["thinking"] = one_line(block.get("thinking"))
    elif kind == "tool_use":
        apply_tool_use(activity, block)


def apply_tool_use(activity, block):
    name = block.get("name") or ""
    tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
    activity["lastTool"] = name
    activity["lastToolInput"] = tool_input
    if name.endswith("__update_plan"):
        if isinstance(tool_input.get("items"), list):
            items = [i for i in tool_input["items"] if isinstance(i, dict)]
            activity["steps"] = [one_line(i.get("content"), 90) for i in items]
            current = [n for n, i in enumerate(items) if i.get("status") == "in_progress"]
            activity["step"] = current[0] if current else -1
        elif tool_input.get("advance"):
            activity["step"] += 1
        elif isinstance(tool_input.get("start"), int):
            activity["step"] = tool_input["start"] - 1
    elif name.endswith("__wrap_up"):
        activity["recap"] = one_line(tool_input.get("recap"), 300)
        activity["ask"] = one_line(tool_input.get("ask"))
        activity["steps"] = []
        activity["step"] = -1
    if block.get("id"):
        activity["pending"][block["id"]] = (name, tool_input)


def classify(session, activity):
    """Return (state, what it is doing now)."""
    status = session.get("status")
    pending = list(activity["pending"].values())
    latest = describe_tool(*pending[-1]) if pending else ""
    if status == "waiting":
        return "needs-you", one_line(latest or session.get("waitingFor") or "Waiting for you")
    if status == "busy":
        if pending and pending[-1][0] == "Agent":
            return "subagent", latest
        if pending and pending[-1][0] == "Monitor":
            return "polling", latest
        if pending:
            return "running", latest
        return "thinking", activity["thinking"] or activity["text"] or "Thinking"
    if activity["ask"]:
        return "decision", activity["ask"]
    wakes = activity["lastTool"] == "ScheduleWakeup" and not activity["lastToolInput"].get("stop")
    if wakes:
        return "polling", describe_tool("ScheduleWakeup", activity["lastToolInput"])
    return "idle", activity["recap"] or activity["text"] or activity["prompt"] or "No activity yet"


def to_row(session, now):
    activity = read_activity(find_transcript(session))
    state, doing = classify(session, activity)
    steps, step = activity["steps"], activity["step"]
    current = "%d/%d %s" % (step + 1, len(steps), steps[step]) if 0 <= step < len(steps) else ""
    return {
        "pid": session["pid"],
        "sessionId": session.get("sessionId") or "",
        "hostId": session.get("hostSessionId") or "",
        "title": one_line(session.get("name") or os.path.basename(session.get("cwd") or "") or "Untitled", 70),
        "state": state,
        "doing": doing,
        "step": current,
        "prompt": activity["prompt"],
        "ageSeconds": max(0, int((now - (session.get("statusUpdatedAt") or now)) / 1000)),
    }


def main():
    now = time.time() * 1000
    rows = []
    for path in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(path, encoding="utf-8") as handle:
                session = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(session, dict) or session.get("spare") or not is_alive(session.get("pid")):
            continue
        rows.append(to_row(session, now))
    rows.sort(key=lambda row: (RANK.get(row["state"], 9), row["ageSeconds"]))
    print(json.dumps({"rows": rows}, ensure_ascii=False))


if __name__ == "__main__":
    main()
