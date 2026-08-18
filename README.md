# shortcut-agent-cli

`shortcut-agent` is an agent-first command-line interface for coordinating work in
[Shortcut](https://shortcut.com). It is inspired by
[Beads](https://beads.gascity.com/), but uses Shortcut as the shared source of
truth instead of introducing another task database.

The CLI intentionally does not mirror the Shortcut REST API. Its public commands
model the workflow an orchestrator and a group of coding agents need:

1. Create a dependency graph inside an Epic.
2. Find unclaimed work whose blockers are complete.
3. Claim a Story, recording both the responsible Shortcut member and the agent
   run that made the claim.
4. Leave structured progress and handoff context.
5. Complete, cancel, or release work so the next Stories become available.

The default output is stable JSON. Human-oriented output is available with
`--human`.

## Status

This repository contains an initial, usable implementation of the core workflow:

- configuration and workspace discovery
- create, show, edit, and Epic-scoped list
- ready and blocked work detection
- guarded start, complete, cancel, release, and handoff operations
- dependency add/remove with cycle detection for same-Epic blocking edges
- compact Epic context summaries
- configuration diagnostics

Shortcut REST API v4 is used throughout. Shortcut currently describes v4 as an
alpha API, so all transport-specific behavior is isolated in `src/client.js` and
tested independently from the CLI's normalized output.

## Requirements and installation

- Node.js 22 or newer
- A Shortcut v4 read/write token (`sct_rw_...`)

For development:

```sh
npm install
npm link
shortcut-agent help
```

No runtime npm dependencies are used. From a checkout, commands can also be run
directly:

```sh
node ./bin/shortcut-agent.js help
```

Store the token in the environment; it is never written to project config:

```sh
export SHORTCUT_API_TOKEN='sct_rw_...'
```

## Shortcut model

| Agent concept | Shortcut primitive |
| --- | --- |
| Project or work graph | Epic |
| Work item | Story |
| Blocking dependency | Story Link with verb `blocks` |
| Non-blocking association | Story Link with verb `relates to` |
| Responsible human | Story Owner |
| Current lifecycle | Workflow State |
| Agent/run attribution | Structured Story comments |
| Portfolio of projects | Objective, outside the initial CLI scope |

Shortcut's legacy Project resource is deliberately not used because Shortcut has
deprecated it. Every create/list/ready/blocked/context operation requires an Epic,
either explicitly or from `.shortcut-agent.json`.

## Initial configuration

Run `init` from the repository or project directory that should use an Epic:

```sh
shortcut-agent init --epic 12345 --agent codex-worker-1
```

`init` calls v4 `whoami`, discovers the workspace slug and workflow states, and
writes `.shortcut-agent.json`. It chooses state IDs by semantic state type rather
than assuming state names. Explicit state IDs can override discovery:

```sh
shortcut-agent init \
  --epic 12345 \
  --agent codex-worker-1 \
  --ready-state 500000001 \
  --started-state 500000002 \
  --done-state 500000003 \
  --cancelled-state 500000004
```

Example configuration:

```json
{
  "workspace": "acme",
  "epic_id": 12345,
  "team_id": "b2c34c3a-1111-2222-3333-0123456789ab",
  "agent_id": "codex-worker-1",
  "states": {
    "ready": 500000001,
    "started": 500000002,
    "done": 500000003,
    "cancelled": 500000004
  }
}
```

The config file is discovered by walking from the current directory toward the
filesystem root. Use `--config PATH` to select one explicitly.

The config contains no credential and may be committed when a repository always
maps to the same Epic. In a shared checkout, omit or override `agent_id` with
`SHORTCUT_AGENT_ID` so parallel workers do not all inherit one identity.

Configuration precedence is:

1. command-line option
2. environment variable
3. `.shortcut-agent.json`

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `SHORTCUT_API_TOKEN` | Required v4 token |
| `SHORTCUT_API_URL` | API base URL; primarily useful for tests/proxies |
| `SHORTCUT_WORKSPACE` | Workspace slug override |
| `SHORTCUT_EPIC_ID` | Default Epic ID |
| `SHORTCUT_TEAM_ID` | Default Team UUID |
| `SHORTCUT_AGENT_ID` | Stable logical agent identity |
| `SHORTCUT_AGENT_RUN_ID` | Ephemeral orchestrator session/thread identity |

Run diagnostics after setup:

```sh
shortcut-agent doctor
shortcut-agent config
```

## Core workflow

### Create a Story

Descriptions are required so that ready work is self-contained. They may be
provided inline, from a file, or through stdin:

```sh
shortcut-agent create \
  --title 'Add cache invalidation' \
  --description-file ./story.md \
  --blocked-by 41 \
  --blocks 72 \
  --related-to 19

printf 'Implement the agreed cache key design.' | \
  shortcut-agent create --title 'Implement cache keys' --description-file -
```

Dependency flags can be repeated or comma-separated. Their direction is natural:

- `--blocked-by 41`: Story 41 blocks the new Story.
- `--blocks 72`: the new Story blocks Story 72.
- `--related-to 19`: a non-blocking relation.

The default Shortcut Story type is `chore`; use `--type bug|chore|feature` to
override it.

### Inspect work

```sh
shortcut-agent list
shortcut-agent ready
shortcut-agent blocked
shortcut-agent show 456
shortcut-agent context
```

A Story is ready only when all of the following hold:

- it belongs to the selected Epic
- it is not archived
- its workflow-state type is `backlog` or `unstarted`
- Shortcut reports `blocked: false`
- it has no owner, unless `ready --include-assigned` is used

Results are ordered deterministically by Shortcut position and then Story ID.
`ready` returning no work is a successful empty result, not an error.

### Claim work

```sh
shortcut-agent start 456
```

`start` verifies that the Story is in the configured Epic, ready, unblocked, and
unowned. It then assigns the member returned by v4 `whoami`, moves the Story to
the configured Started state, and writes a structured claim comment.

Shortcut's public API does not expose compare-and-swap or `If-Match` semantics.
Owner and state are updated in one request and the result is verified, but two
agents can still race. A stateless CLI cannot guarantee a Beads-style atomic
claim. Use one orchestrator to serialize claims when strict exclusion is needed.

### Handoff and progress

```sh
shortcut-agent handoff 456 \
  --summary 'Parser is implemented; integration remains' \
  --changed 'src/parser.js,test/parser.test.js' \
  --verification 'npm test -- parser' \
  --remaining 'Wire parser into the command dispatcher'

shortcut-agent handoff 456 --summary 'Pausing work' --release
```

Handoff comments contain a readable Markdown section and a fenced
`shortcut-agent` JSON event. The JSON carries a format version, event type,
stable `agent_id`, ephemeral `run_id`, event ID, and timestamp. Shortcut comment
`external_id` is also populated to support idempotent reconciliation.

The MVP uses comments rather than a custom field for agent claims. A future
optional `Active Agent` enum field should contain only stable, explicitly
registered identities; ephemeral run and claim IDs must never become enum values.

### Complete, cancel, or release

```sh
shortcut-agent complete 456 \
  --summary 'Implemented cache invalidation' \
  --verification 'npm test' \
  --evidence 'https://github.com/acme/repo/pull/123'

shortcut-agent cancel 456 --reason 'Requirement removed'
shortcut-agent release 456 --reason 'Agent is shutting down'
```

- `complete` records evidence and moves to the configured Done state.
- `cancel` records a reason and moves to Cancelled, or Done when no distinct
  Cancelled state is configured. A Done-type cancellation unblocks dependents.
- `release` records a reason, removes owners, and returns to the Ready state.
- Lifecycle commands require the authenticated member to own the Story. `--force`
  is available for deliberate recovery by an orchestrator.

### Edit and dependencies

```sh
shortcut-agent edit 456 --title 'Revised title' --description-file ./revised.md

shortcut-agent dep add 456 --blocked-by 41
shortcut-agent dep add 456 --blocks 72
shortcut-agent dep add 456 --related-to 19
shortcut-agent dep remove 456 --blocked-by 41
```

For same-Epic blocking relationships, `dep add` builds the current graph and
rejects an edge that would create a cycle. Cross-Epic dependencies require
`--allow-cross-epic`; the CLI warns that it cannot prove the combined graph is
acyclic from one Epic-scoped read.

## Agent identity

Three IDs serve different lifetimes:

- `agent_id`: stable logical worker identity, configured with `--agent`,
  `SHORTCUT_AGENT_ID`, or `agent_id` in project config
- `run_id`: orchestrator session/thread identity, preferably supplied through
  `SHORTCUT_AGENT_RUN_ID`; otherwise generated per command
- event/claim ID: a UUID generated for one lifecycle mutation

Parallel orchestrators should provide stable worker-slot agent IDs such as
`worker-1` and `worker-2`, and unique run IDs for individual sessions. Random
run IDs are stored only in comments and therefore do not create an ever-growing
workspace schema.

## Output and errors

Successful output is JSON on stdout:

```json
{
  "ok": true,
  "command": "ready",
  "epic_id": 12345,
  "stories": []
}
```

Errors are JSON on stderr:

```json
{
  "ok": false,
  "error": {
    "code": "claim_conflict",
    "message": "Story 456 already has an owner",
    "details": {}
  }
}
```

Stable exit-code families:

| Exit | Meaning |
| --- | --- |
| `0` | Success, including an empty ready list |
| `2` | Invalid command or arguments |
| `3` | Missing or invalid configuration |
| `4` | Claim/state/dependency conflict |
| `5` | Shortcut authentication or authorization failure |
| `6` | Shortcut API or network failure |

Use `--pretty` for indented JSON and `--human` for concise text. No command uses
an interactive prompt, pager, color, or spinner.

## Development

```sh
npm test
npm run lint
```

The implementation uses only Node standard-library modules:

- `src/args.js`: deterministic CLI parsing
- `src/config.js`: config discovery and precedence
- `src/client.js`: Shortcut v4 HTTP, pagination, envelopes, and rate-limit handling
- `src/domain.js`: normalized Stories, readiness, and dependency graph logic
- `src/comments.js`: versioned agent lifecycle comments
- `src/commands.js`: agent workflow operations
- `src/main.js`: dispatch, output, and exit codes

Tests use Node's built-in test runner and local mock HTTP servers. They do not
require a Shortcut token or network access.

## Security and operational notes

- Never commit `SHORTCUT_API_TOKEN` or put it in `.shortcut-agent.json`.
- A v4 read/write token acts as its Shortcut member; shared tokens also share the
  same Story owner identity.
- Comments identify the agent run but are not locks and are not used as the sole
  readiness source.
- Mutating requests are not blindly retried after ambiguous network failures.
- HTTP 429 responses are retried according to `Retry-After`; safe GET requests
  receive bounded transient retries.
- Shortcut is the only work database. The local JSON file contains configuration,
  not synchronized task state.

## Near-term roadmap

- `plan apply` for validating and bulk-creating a JSON/YAML Story DAG
- optional explicitly managed `Active Agent` custom field
- stale-claim leases and recovery reports
- richer graph output (adjacency JSON, Mermaid, and DOT)
- audit checks for orphaned work and cross-Epic dependency health
- pinned v4 OpenAPI fixtures and automated schema drift checks
