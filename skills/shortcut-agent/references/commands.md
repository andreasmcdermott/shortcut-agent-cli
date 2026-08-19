# `shortcut-agent` command reference

Verified against the implementation. Run `shortcut-agent COMMAND --help` (or
`shortcut-agent help COMMAND`) for concise command-specific usage; this file is
the complete behavioral reference.

## Global options

| Option | Effect |
| --- | --- |
| `--config PATH` | Select a config file explicitly |
| `--api-url URL` | Override API base URL (tests/proxies) |
| `--workspace SLUG` | Override workspace |
| `--epic ID` | Override the configured Epic |
| `--team UUID` | Override the configured Team |
| `--agent ID` | Override agent identity for this invocation |
| `--human` | Concise text instead of JSON |
| `--pretty` | Indented JSON |

Precedence: command-line option → environment variable →
`.shortcut-agent.local.json` → `.shortcut-agent.json`.

Boolean flags may be negated with `--no-<flag>`. `--flag=value` is accepted.

A value-taking option supplied without a value is a hard error. `--epic` with no
value fails rather than resolving to a default, so an unset shell variable
cannot silently retarget the command.

## Environment

| Variable | Purpose |
| --- | --- |
| `SHORTCUT_API_TOKEN` | Required v4 read/write token (`sct_rw_...`) |
| `SHORTCUT_API_URL` | API base URL override |
| `SHORTCUT_WORKSPACE` | Workspace slug |
| `SHORTCUT_EPIC_ID` | Default Epic |
| `SHORTCUT_TEAM_ID` | Default Team UUID |
| `SHORTCUT_AGENT_ID` | Stable logical worker identity |
| `SHORTCUT_AGENT_RUN_ID` | Ephemeral session identity |

The token is never written to either config file.

## Setup

### `init --epic ID`

Calls v4 `whoami`, discovers workspace slug and workflow states **by state type**
(not by name), and writes `.shortcut-agent.json`. Prefers states in the member's
default workflow.

Workflow selection follows the Epic, not the caller: `--workflow ID`, else the
default workflow of `--team`, else the Epic's own team's default workflow, else
the authenticated member's default. The result is reported as `workflow.id` /
`workflow.name` / `workflow.source`, and the Epic's team is adopted as `team_id`
unless `--team` overrides it. **Check `workflow.source` after running init** —
`member` means the Epic had no team and states came from the caller's personal
default, which is often the wrong board.

State discovery within that workflow: `ready` ← first `unstarted`, else
`backlog`. `started` ← first `started`. `done` ← first `done` matching
/done|complete|finish/i, else any `done`. `cancelled` ← first `done` matching
/cancel|won't|wont|abandon/i, else falls back to `done`.

Overrides: `--workflow ID`, `--team UUID`, `--ready-state ID`,
`--started-state ID`, `--done-state ID`, `--cancelled-state ID`. Fails with exit 3 if ready/started/done cannot be
resolved.

`--agent ID` writes identity to `.shortcut-agent.local.json` (git-ignored), not
to the shared config. Re-running `init` migrates a legacy `agent_id` out of the
shared file.

### `config` / `doctor`

`config` prints effective resolved configuration and where each value came from.
`doctor` runs connectivity and configuration diagnostics.

## Reading

### `list [--epic ID]`

Every Story in the Epic, sorted by Shortcut position then ID.

### `ready [--include-assigned]`

Stories that satisfy **all** of: in the Epic, not archived, state type is
`backlog` or `unstarted`, `blocked` is not `true`, and no owners.
`--include-assigned` drops only the owner condition. An empty list exits `0`.

### `blocked`

Stories with `blocked: true`, each with its blocker Stories fetched and inlined
under `blockers`. Unreachable blockers appear as `{id, unavailable: true}`.

### `show STORY [--all-comments]`

Story with description plus comments — the last 10 by default. Each comment
includes `agent_event`: the parsed `shortcut-agent` JSON block, or `undefined`
for human comments. **`show` is not Epic-scoped**, so it works on any Story ID.

### `claims [--mine|--held-by ID] [--stale] [--stale-minutes N]`

Every in-flight Story in the Epic — owned, or in a `started` state, and neither
done nor archived — with the agent that holds it. Read-only.

Per entry: `story`, `agent_id`, `run_id`, `claimed_at`, `last_event`,
`idle_minutes`, `stale`, `unattributed`.

`agent_id` and `claimed_at` come from the most recent `claim` event on the
Story. `idle_minutes` is measured from the most recent agent event of any type
(falling back to `updated_at`), so an agent posting handoff progress is not
counted as idle. `stale` is `idle_minutes >= --stale-minutes`, default 60;
`0` is accepted and marks everything stale.

`unattributed: true` means the Story is held but has no parseable claim event —
claimed outside the CLI, or a claim whose comment write failed (see the `start`
warning path).

Filters: `--mine` restricts to the configured agent identity, `--held-by ID` to
a named one, `--stale` to stale entries only.

Recovery is the ordinary lifecycle command, not part of `claims`:

```sh
shortcut-agent release 456 --reason 'Reclaiming stale claim from worker-2' --force
```

### `context`

Compact whole-graph summary: Epic metadata, `counts`, and the
`ready` / `active` / `blocked` / `other` arrays plus `recently_done` (last 10).

Classification order: `done` type → `blocked: true` → ready → `started` type →
`other`.

## Writing

### `create --title T --description TEXT|--description-file PATH`

Title may also be given as the first positional argument. Description is
required and may be inline, from a file, or from stdin via
`--description-file -`. Inline and file forms are mutually exclusive.

The Story is created in the configured Epic, in the **ready** state, with the
configured team applied.

| Option | Notes |
| --- | --- |
| `--type bug\|chore\|feature` | Default `chore` |
| `--estimate N` | Positive integer |
| `--blocked-by ID` | Repeatable and comma-separated |
| `--blocks ID` | Repeatable and comma-separated |
| `--related-to ID` | Repeatable and comma-separated |

### `edit STORY <field...>`

Requires at least one field. Not Epic-scoped on entry.

| Option | Effect |
| --- | --- |
| `--title T` | Rename |
| `--description TEXT` / `--description-file PATH` | Replace description |
| `--type bug\|chore\|feature` | Change type |
| `--estimate N` / `--clear-estimate` | Set or null the estimate |
| `--move-to-epic ID` | Move the Story to another Epic (explicit ID required) |
| `--set-team [UUID]` / `--clear-team` | Set the team (defaults to the configured team), or null it |
| `--state ID` | Raw workflow state ID — bypasses lifecycle guards |

`--state` is an escape hatch. Prefer `start`/`complete`/`cancel`/`release`.

Global scope options never mutate. `--epic` and `--team` only select what the
command operates on; only `--move-to-epic` and `--set-team` change the Story.

## Lifecycle

### `start STORY`

Preconditions, all enforced: Story is in the configured Epic, `blocked` is not
`true`, state type is `backlog` or `unstarted`, and there are no owners.

Then: assigns the `whoami` member, moves to the started state, writes a `claim`
comment, and **re-reads to verify** owner and state survived. Failed
verification raises `claim_conflict`.

If the claim succeeds but the comment write fails, the command still succeeds
and reports the problem in `warnings`.

Returns `claim` (the event metadata), `claim_comment_id`, `story`, `warnings`.

### `complete STORY --summary TEXT`

Requires ownership by the authenticated member, and state type `started` unless
`--force`. Moves to the done state.

Optional: `--verification TEXT`, `--evidence TEXT`, `--changed TEXT`,
`--remaining TEXT`.

### `cancel STORY --reason TEXT`

Requires ownership **or** an unowned Story. Moves to the cancelled state, or the
done state when no distinct cancelled state is configured.

Because the target is a Done-type state, cancelling **unblocks dependents**. The
response carries a warning when the Story had `blocks` edges.

### `release STORY --reason TEXT`

Requires ownership. Clears all owners and returns the Story to the ready state.
Use `--force` (orchestrator only) to reclaim a stale claim held by a dead agent.

### `handoff STORY --summary TEXT [--release]`

Requires ownership. Always writes a `handoff` comment. With `--release`, also
clears owners and returns to ready. Without it, the claim is retained.

Optional: `--changed`, `--verification`, `--remaining`, `--evidence`.

Returns `event`, `comment_id`, `released`, `story`.

## Dependencies

### `dep add|remove STORY <one relation>`

**Exactly one** of `--blocked-by ID`, `--blocks ID`, `--related-to ID` per
invocation. Multiple or comma-separated values are an argument error — this is
the opposite of `create`.

`dep add`:
- Cross-Epic edges require `--allow-cross-epic` and return a warning that cycle
  safety could not be proven.
- An existing identical edge returns `unchanged: true` — idempotent, safe to
  retry.
- For same-Epic `blocks` edges, the full Epic graph is loaded (paginating story
  links where needed) and a DFS rejects any edge that would close a cycle.

`dep remove` deletes all links matching subject, object, and verb exactly.
No match raises `dependency_not_found`.

## Agent event comments

Every lifecycle mutation writes a Markdown section plus a fenced
`shortcut-agent` JSON block:

```json
{"version":1,"event":"claim","event_id":"<uuid>","agent_id":"worker-3","run_id":"<uuid>","timestamp":"..."}
```

Events: `claim`, `handoff`, `complete`, `cancel`, `release`. `claim` events also
carry `story_id` and `owner_id`.

Comment `external_id` is `shortcut-agent:<event>:<event_id>` (truncated to 128
chars), which supports idempotent reconciliation.

`show` parses these into `agent_event`. Only `version: 1` blocks are returned;
anything else parses to `undefined`.

**These comments are attribution, not locks.** Readiness is never derived from
them.

## Errors

Errors are JSON on stderr:

```json
{"ok": false, "error": {"code": "claim_conflict", "message": "...", "details": {}}}
```

| Exit | Codes |
| --- | --- |
| `2` | `invalid_arguments`, including a value-taking flag passed with no value |
| `3` | `invalid_configuration` |
| `4` | `claim_conflict`, `story_blocked`, `invalid_story_state`, `ownership_conflict`, `story_outside_epic`, `dependency_cycle`, `cross_epic_dependency`, `dependency_not_found` |
| `5` | Shortcut auth/authorization failure |
| `6` | Shortcut API/network failure, `unexpected_error` |

Transport-level mapping: HTTP 401 → exit 5 (`shortcut_authentication_error`),
403 → exit 5 (`shortcut_authorization_error`), 409 and 422 → exit 4, everything
else including 404 → exit 6.

HTTP 429 is retried per `Retry-After`. Safe GETs get bounded transient retries,
as do 5xx responses.
Mutations are **not** retried after ambiguous network failures — re-read with
`show` and decide from observed state.

No command prompts, pages, colors, or spins. Every command is safe to run
non-interactively.
