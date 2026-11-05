# Session Board

A Claude Code mod that shows every live Claude session on your machine in one pane, so you can see which ones need you without jumping between them.

## What it does

- Lists each live session as a card with an animated status dot.
- Blue means the session is waiting on you, green means it is working, amber means it is polling, gray means it is idle.
- Click a card to expand it and see its current activity, plan step and your last prompt.
- Send a message to a session from its card, or open the session in the app.
- Press ✕ to stop showing a session, and `Show all` to bring them all back.
- `+ Add session` lists your other sessions. Picking a removed one brings its card back. Picking a stopped one opens it in the app, and its card appears once it is running.

The pane opens when a session starts. Type `/sessions` to reopen it.

## Requirements

- macOS with `python3` available
- The Claude desktop app, for opening sessions and sending messages

## Install

At the prompt of a terminal session:

```
/plugin install session-board --marketplace khaledosama999/session-board
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install session-board --marketplace khaledosama999/session-board
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `khaledosama999/session-board`, then Add plugin.

## Limits

- It shows sessions with a running process only. A session that has not been opened since the app restarted stays hidden until you open it.
- Claude's thinking text is mostly empty in transcripts, so cards show the latest tool, plan step or message instead.
- A message arrives labeled as coming from the session hosting the pane, not as typed by you. It cannot answer a permission prompt.

## How it works

`bin/snapshot.py` reads `~/.claude/sessions/*.json` and the end of each session's transcript. It runs every 3 seconds, reads only, and keeps everything on your machine. `hooks/register.tsx` draws the pane and `hooks/card.tsx` draws each card.

Run the tests with `claude plugin test .`.
