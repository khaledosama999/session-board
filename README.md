# Session Board

A Claude Code mod that shows live sessions on your machine, with a local browser companion for Codex.

## Codex

On macOS with Python 3 and a recent Codex CLI, run this from a checkout:

```sh
python3 codex/board.py
```

Open the printed local URL. The board refreshes every three seconds and groups up to 100 recent, unarchived chats by workspace. Expand a card for its preview and **Open in Codex** to jump to the chat in the desktop app. Press Ctrl+C to stop the board.

The board uses the [Codex App Server](https://learn.chatgpt.com/docs/app-server) to read chat metadata. It lists saved chats and their last update time. Live desktop activity, approval alerts, and sending messages are outside this version. The board listens only on loopback.

## What it does (Claude Code)

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
- A recent Claude Code. Tested on 2.1.317. Version 2.1.121 fails with `unknown option '--marketplace'`, and the exact minimum version is not known. Run `claude --version` to check yours.

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
- A message from a card arrives as your own words when the target session also runs this mod, so install it at user scope. Claude reads it as if you typed it, though the transcript still shows a small plugin label. If the target does not run the mod, the app delivers it labeled as coming from the session hosting the pane. Either way it cannot answer a permission prompt, and a busy session gets it once it is idle.

## How it works

`bin/snapshot.py` reads `~/.claude/sessions/*.json` and the end of each session's transcript. It runs every 3 seconds, reads only, and keeps everything on your machine. Card messages wait as files in `~/.claude/session-board/inbox/<session id>/`, and each session running the mod checks its own inbox every 3 seconds, without using any tokens until a message arrives. Each session also notes it is running in `~/.claude/session-board/alive/` every 10 seconds, so cards know which way to send. `hooks/register.tsx` draws the pane and `hooks/card.tsx` draws each card.

Run the tests with `claude plugin test .`.
