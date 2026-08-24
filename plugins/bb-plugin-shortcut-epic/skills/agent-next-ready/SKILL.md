---
name: agent-next-ready
description: Claim and implement the next available Story from a Shortcut Agent Epic. Use whenever the user invokes /agent-next-ready or asks to pick up, grab, claim, or start the next ready/available/unblocked Story, to pull the next item off the Epic queue, or to keep working through a Shortcut Agent Epic. Also use when asked "what should I work on next" in a project that has a .shortcut-agent.json.
---

# Pick up the next ready Story

Claim exactly one Story from the Epic queue, then implement it. The queue is
Epic-scoped, so every command needs an Epic.

## 1. Resolve the Epic

Pass `--epic ID` explicitly on every call. Resolve the ID in this order:

1. An Epic ID or Epic URL in the user's message — including an argument to the
   slash command, as in `/agent-next-ready 45871`.
2. `bb shortcut-agent config` — reports the effective `epic_id` from the bb
   project's `.shortcut-agent.json`.

If neither yields an Epic, stop and ask the user which Epic to pull from. Do not
guess, and do not fall back to an Epic mentioned earlier in the conversation for
different work.

## 2. Read the queue

```sh
bb shortcut-agent ready --epic 45871
```

`ready` returns `{ ok, command, epic_id, stories }` on stdout as JSON, sorted by
Shortcut position then ID, so **`stories[0]` is the next Story to pick up**. It
lists only Stories that are in the Epic, not archived, in a `backlog`/`unstarted`
state, not `blocked`, and unowned — so anything another agent has already claimed
is already filtered out. Add `--pretty` while debugging.

- Empty `stories`: say so and stop. Run `bb shortcut-agent blocked --epic ID` and
  report what is blocking the queue rather than inventing work or claiming a
  Story that is blocked or owned.
- Do not use `--include-assigned` to find work. It drops the owner filter and
  will surface Stories other agents hold.

## 3. Claim it

Read the full Story first — the description is the entire handoff, and the
`ready` summary omits it:

- `shortcut_agent_show` (native tool), or `bb shortcut-agent show STORY`.

Then claim it:

- `shortcut_agent_start` (native tool), or `bb shortcut-agent start STORY`.

Both mutating paths require **Enable agent mutations** in Extensions → Plugins →
Shortcut Agent. If it is off, the command exits `3` with
`agent_mutations_disabled` — report that the user has to enable it, and do not
try to work around it by editing the Story through another route.

Exit code `4` with `claim_conflict` is ordinary contention, not a failure:
another agent took the Story between your `ready` and your `start`. Re-run
`ready --epic ID` and try the next Story. Give up after three conflicts and tell
the user the queue is contended.

`start` assigns the Story, moves it to the started state, and writes a `claim`
comment attributed to this bb thread. Report the claimed Story ID, title, and
`app_url` to the user before you begin work.

## 4. Implement it

Work the Story from its description, not from assumptions. If the description
does not stand alone, say what is missing instead of guessing — then either ask
the user, or `bb shortcut-agent release STORY --reason '...'` so it returns to
the queue for someone with context.

Claim one Story per invocation. Do not chain into the next one unless the user
asks.

When the work is done and verified:

```sh
bb shortcut-agent complete STORY --summary 'What changed' --verification 'How it was checked'
```

Use `bb shortcut-agent handoff STORY --summary '...' [--release]` to record
partial progress, and `release` if you are stopping without finishing.

## Notes

- `bb shortcut-agent` reads the Shortcut token server-side and resolves project
  scope from the invoking bb project. `init`, `--config`, `--api-url`, and
  `--description-file` are unsupported there.
- Story payloads from this CLI do not include `formatted_vcs_branch_name`. If the
  project requires the canonical Shortcut branch name, get it from Shortcut
  directly before creating or renaming a branch.
