"""Build short session card details from recent Codex turns."""

from time import monotonic


def snippet(value, limit=220):
    if not isinstance(value, str):
        return ""
    line = " ".join(value[:limit * 4].split())
    return line if len(line) <= limit else line[:limit - 1].rstrip() + "…"


def user_text(item):
    return next((
        part["text"] for part in item.get("content", [])
        if part.get("type") == "text" and part.get("text", "").strip()
    ), "")


def current_activity(items):
    for item in reversed(items):
        if item["type"] == "userMessage":
            break
        if item.get("status") == "inProgress":
            if item["type"] == "mcpToolCall":
                return snippet(item.get("tool", "").replace("_", " "), 100)
            if item["type"] == "commandExecution":
                return "Running a command"
            if item["type"] == "dynamicToolCall":
                return snippet(item.get("tool", "").replace("_", " "), 100)
        if item["type"] == "agentMessage" and item.get("phase") == "commentary":
            return snippet(item.get("text"))
    return ""


def summarize(turns, status):
    if not turns:
        return {}
    latest = turns[0]
    items = [item for turn in turns for item in reversed(turn.get("items", []))]
    asked = next((text for item in items if item["type"] == "userMessage" and (text := user_text(item))), "")
    replies = [item for item in items if item["type"] == "agentMessage" and item.get("text", "").strip()]
    reply = next((item for item in replies if item.get("phase") != "commentary"), None)
    if reply is None and status != "working" and replies:
        reply = replies[0]
    return {
        "asked": snippet(asked),
        "last": snippet(reply["text"]) if reply else "",
        "now": current_activity(latest.get("items", [])) if status == "working" else "",
        "activityAt": latest.get("completedAt") or latest.get("startedAt"),
    }


class Activity:
    def __init__(self):
        self.cache = {}

    def populate(self, app, rows):
        current = {}
        for row in rows:
            status = row.get("status")
            if not status:
                continue
            thread_id = row["id"]
            key = (status, row["updatedAt"])
            entry = self.cache.get(thread_id)
            if entry is None or entry[0] != key or monotonic() >= entry[1]:
                try:
                    result = app.request("thread/turns/list", {
                        "threadId": thread_id, "limit": 2, "itemsView": "full",
                    })
                    details = summarize(result["data"], status)
                except (OSError, RuntimeError):
                    details = {}
                interval = 4 if status == "working" else 30
                entry = (key, monotonic() + interval, details)
            current[thread_id] = entry
            row.update(entry[2])
        self.cache = current
