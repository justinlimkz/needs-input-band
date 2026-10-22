# needs-input-band

A Claude Code mod that pins a band above the prompt listing research docs (Claude docs) that are waiting
on your input. Each row links to the doc. Items appear and clear on their own.

```
● Needs your input · my-project · 2
  › Report 09: the swap ledger can't be answered directly · 4 decisions · 10m
  › Criteria v2 · 1 decision · 1h
```

## How it works

- The doc is the source of truth. A decision is a list item or table cell whose text contains the literal
  `(you)`. Settle it by replacing `(you)` with `(decided: <answer>)`.
- When a Claude Docs write happens, the mod notes the doc. At the end of the turn it reads the doc back
  and recounts. 0 open decisions removes the item; 1 or more adds or updates it. A failed read never removes an item.
- Pending items are re-read on the first turn of a session and about every 5 minutes.
- Items are stored per project (the git common directory, so worktrees share a list) and persist across sessions.
- A system-prompt section, present only while items are pending, tells the model to settle a decision by editing the doc.

## Requirements

- Claude Code with the mods (function hooks) API, written against 2.1.305. This API is early access and may change.
- The Claude Docs connector.
- Permission for the connector's read tool, in `~/.claude/settings.json`:
  `{ "permissions": { "allow": ["mcp__claude_ai_Claude_Docs__read"] } }`
- A report skill or habit that marks each open decision with `(you)` and settles it with `(decided: ...)`.
- Clickable titles need a terminal Claude Code recognises as supporting hyperlinks, or
  `{ "env": { "FORCE_HYPERLINK": "1" } }` in settings.

## Install

In a Claude Code session:

```
/plugin install needs-input-band --marketplace justinlimkz/needs-input-band
```

Or from a shell: `claude plugin install needs-input-band --marketplace justinlimkz/needs-input-band`.
A private repository needs a GitHub credential on the machine (`gh auth login`, then `gh auth setup-git`).

## Commands

`/needs-input` lists items. `/needs-input add <doc link>` reads a doc written where the mod could not see it.
`/needs-input clear <n|all>` hides items until their open decisions change. `/needs-input hide` and `show` toggle the band
for the session. `/needs-input label <text>` renames the project label.

## Development

`claude plugin test .` runs the tests; `claude plugin validate .` checks the manifest and module.
Run it from a folder with `claude --plugin-dir <this folder>`.
