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
- claim attribution and stale-claim reporting
- configuration diagnostics
- an optional Shortcut Agent bb plugin that renders the configured Epic, registers a server-side `bb shortcut-agent` command, and exposes schema-validated native agent tools

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

Every command has focused help that does not require configuration or API
access:

```sh
shortcut-agent create --help
shortcut-agent ready --help
shortcut-agent dep add --help
# Equivalent form:
shortcut-agent help ready
```

Store the token in the environment; it is never written to project config:

```sh
export SHORTCUT_API_TOKEN='sct_rw_...'
```

## Shortcut Agent bb plugin

This repository also contains `bb-plugin-shortcut-epic`, a separate bb plugin
under `plugins/bb-plugin-shortcut-epic`. It reads the same checked-in
`.shortcut-agent.json`, fetches the configured Epic through Shortcut v4, and
adds a **Shortcut Agent** nav panel to bb. Its stable package and plugin ID
remain `shortcut-epic` so existing installations keep their settings.

The graph lays out blocking relations from prerequisite to dependent. Started
work is ring-highlighted, and ready and blocked Stories are distinguished.
Completed Stories are hidden by default to keep large graphs balanced, with a
header toggle to restore the faded history. Zoom controls and a **Fit** action
help navigate large graphs. Story cards open their corresponding Shortcut page.
The **Epic ID** control switches the active Epic, puts that
selection in the panel URL, and remembers the last opened Epic per bb project in
the current browser. The graph itself remains read-only and refreshes every 60
seconds.

The plugin also runs the CLI workflow inside the bb server, where it can use the
same secret token without exposing that token to agents, the frontend, shell, or
project files:

```sh
bb shortcut-agent show 319163
bb shortcut-agent ready
bb shortcut-agent create --title 'Follow-up' --description 'Self-contained work'
bb shortcut-agent dep add 319163 --blocked-by 319100
```

Agents additionally receive schema-validated native tools for Epic context,
Story reads, create/edit, dependency addition, and start/complete/release
lifecycle operations. These tools avoid shell quoting mistakes while reusing the
same client, ownership checks, cycle detection, and lifecycle implementation as
the standalone CLI.

bb supports installing a plugin from a repository subdirectory. From this
checkout, either install the plugin folder directly:

```sh
bb plugin install ./plugins/bb-plugin-shortcut-epic
```

or use the repository's `.bb/plugins.json` collection entry:

```sh
bb plugin install path:. --plugin shortcut-epic
```

To install from Git:

```sh
bb plugin install \
  git:https://github.com/andreasmcdermott/shortcut-agent-cli.git@main \
  --plugin shortcut-epic
```

Then open **Extensions → Plugins → Shortcut Agent** and set its **Shortcut API
token**. This is a bb secret setting because the shared project config
deliberately contains no credentials. `SHORTCUT_API_TOKEN` is also accepted
when it belongs to the bb server process; an export made only inside an agent
terminal does not change an already-running desktop server.

The optional **Default bb project** setting resolves ambiguity when several bb
projects contain `.shortcut-agent.json`. Without it, each invocation uses its
current bb project, or the plugin automatically uses the sole configured
project. Mutations from both `bb shortcut-agent` and native tools require the
**Enable agent mutations** setting, which defaults off. Read commands and tools
remain available while mutations are disabled. Lifecycle calls derive a stable
agent identity from the invoking bb thread unless `--agent` / `agentId` is
supplied. See the
[plugin README](./plugins/bb-plugin-shortcut-epic/README.md) for Git
subdirectory installs, configuration behavior, and the development loop.

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
shortcut-agent init --epic 12345
```

`init` calls v4 `whoami`, discovers the workspace slug and workflow states, and
writes the shared project scope to `.shortcut-agent.json` in the current working
directory. It chooses state IDs by semantic state type rather than assuming
state names. Unlike read commands, `init` does not reuse a discovered ancestor
config unless `--update-discovered` is explicitly supplied.

Initialization is create-only by default. If the target already exists and the
discovered document differs, `init` exits with code 3 and reports the existing
and proposed scope without changing the file. Use `--merge` to refresh known
scope and state fields while preserving extra keys such as `api_url`, or
`--force` to replace the document. Reinitialization always rediscovers all
workflow states; use the explicit state options to pin individual IDs.

`--config PATH` and `SHORTCUT_AGENT_CONFIG` may name a file that does not exist
when used with `init`. Other commands continue to treat a missing explicit
config as an error.

Workflow discovery follows the Epic, not the person running the command:

1. `--workflow ID`, when given
2. the default workflow of `--team`, when given
3. the default workflow of the Epic's own team
4. the authenticated member's default workflow

Steps 1-3 matter because a member's default workflow is frequently not the one
their team plans in, and picking the wrong one puts every created Story on the
wrong board. `init` reports the chosen workflow and the `source` that selected
it, and adopts the Epic's team as `team_id` unless `--team` says otherwise.

Explicit state IDs still override everything above:

```sh
shortcut-agent init \
  --epic 12345 \
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
  "states": {
    "ready": 500000001,
    "started": 500000002,
    "done": 500000003,
    "cancelled": 500000004
  }
}
```

Read commands discover project config by walking upward from the current
directory. Discovery stops after checking the first directory containing `.git`
(a directory in normal checkouts or a file in linked worktrees). For non-Git
paths under the user's home it stops at home; outside both Git and home it checks
only cwd. Use `--config PATH` or `SHORTCUT_AGENT_CONFIG` to select one explicitly.
Successful JSON output includes `config_file` and
`config_source` (`cwd`, `ancestor`, `explicit`, `env`, or `none`).

When present, an adjacent `.shortcut-agent.local.json` is layered over the
shared config. This provides a personal fallback without putting identity in
shared config. The local file **must** be ignored by Git; `init --agent` warns
when Git does not report it ignored.

`epic_id` is a convenience default, not durable active-Epic state. Every
Epic-scoped command already accepts `--epic ID`, which has higher precedence.
For a repository that serves multiple Epics, pass `--epic` explicitly (or set
`SHORTCUT_EPIC_ID` per process). Initialize with
`shortcut-agent init --epic ID --no-default-epic` to omit `epic_id` and make an
explicit Epic mandatory; workspace, team, and workflow-state configuration
remain reusable. Requiring the flag for every repository is not recommended,
because a stable single-Epic default is useful and avoids repetitive agent
arguments.

The project config contains no credential or agent identity and may be committed
when a repository always maps to the same Epic. To save a local default agent,
pass it explicitly during initialization:

```sh
shortcut-agent init --epic 12345 --agent codex-worker-1
```

This still writes the shared scope to `.shortcut-agent.json`, but writes the
identity separately:

```json
{
  "agent_id": "codex-worker-1"
}
```

For parallel agents in the same folder, do not use one local default. Give each
process its own `SHORTCUT_AGENT_ID` and `SHORTCUT_AGENT_RUN_ID` instead.
Rerunning `init --merge` (or `--force`) against an older project config migrates
its legacy `agent_id` into the local file and removes it from shared config.

Configuration precedence is:

1. command-line option
2. environment variable
3. `.shortcut-agent.local.json`
4. `.shortcut-agent.json`

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `SHORTCUT_API_TOKEN` | Required v4 token |
| `SHORTCUT_AGENT_CONFIG` | Explicit config path (command-line `--config` wins) |
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
  --related-to 19 \
  --duplicates 88

printf 'Implement the agreed cache key design.' | \
  shortcut-agent create --title 'Implement cache keys' --description-file -
```

Dependency flags can be repeated or comma-separated. Their direction is natural:

- `--blocked-by 41`: Story 41 blocks the new Story.
- `--blocks 72`: the new Story blocks Story 72.
- `--duplicates 88`: the new Story duplicates Story 88.
- `--duplicated-by 88`: Story 88 duplicates the new Story.
- `--related-to 19`: a non-blocking relation.

Only `blocks` edges affect readiness. `duplicates` and `relates to` are recorded
for context and reported in Story summaries.

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
shortcut-agent edit 456 --move-to-epic 777
shortcut-agent edit 456 --set-team b2c34c3a-1111-2222-3333-0123456789ab

shortcut-agent dep add 456 --blocked-by 41
shortcut-agent dep add 456 --blocks 72
shortcut-agent dep add 456 --duplicates 88
shortcut-agent dep add 456 --duplicated-by 88
shortcut-agent dep add 456 --related-to 19
shortcut-agent dep remove 456 --blocked-by 41
```

Scope options and mutations are deliberately separate. `--epic` selects which
Epic a command operates on and never moves a Story; `--move-to-epic` moves it.
The same split applies to `--team` and `--set-team`.

For same-Epic blocking relationships, `dep add` builds the current graph and
rejects an edge that would create a cycle. Cross-Epic dependencies require
`--allow-cross-epic`; the CLI warns that it cannot prove the combined graph is
acyclic from one Epic-scoped read.

### Stale claims

Because a shared token authenticates as one Shortcut member, Story ownership
provides mutual exclusion but not agent identity. `claims` recovers that
identity by reading the structured claim comments:

```sh
shortcut-agent claims
shortcut-agent claims --mine
shortcut-agent claims --stale --stale-minutes 45
shortcut-agent claims --held-by worker-2
```

It reports every in-flight Story in the Epic — owned, or in a started state, and
not done — with the agent that claimed it, the most recent lifecycle event, and
how long it has been idle. `unattributed: true` marks a Story that is held but
carries no claim comment, which happens when work is claimed outside the CLI or
when a claim comment failed to post.

`claims` is read-only. Recover a stale claim with the existing lifecycle
command, which returns the Story to the ready pool:

```sh
shortcut-agent release 456 --reason 'Reclaiming stale claim from worker-2' --force
```

## Agent identity

Three IDs serve different lifetimes:

- `agent_id`: stable logical worker identity, configured with `--agent`,
  `SHORTCUT_AGENT_ID`, or the ignored local config
- `run_id`: orchestrator session/thread identity, preferably supplied through
  `SHORTCUT_AGENT_RUN_ID`; otherwise generated per command
- event/claim ID: a UUID generated for one lifecycle mutation

Parallel orchestrators should provide stable worker-slot agent IDs such as
`worker-1` and `worker-2`, and unique run IDs for individual sessions. Random
run IDs are stored only in comments and therefore do not create an ever-growing
workspace schema. Agents sharing one folder can safely share the project config;
their process-level identity overrides keep attribution separate.

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

- Never commit `SHORTCUT_API_TOKEN` or put it in either config file.
- `.shortcut-agent.local.json` may contain a personal default identity and must
  be ignored by the target repository; `init --agent` warns when it is not.
  `.shortcut-agent.json` is safe to share.
- Config writes use a same-directory temporary file, a short-lived write lock,
  and atomic publish/replace operations, so concurrent readers never observe a
  partial JSON document and concurrent init updates reject stale snapshots.
- A v4 read/write token acts as its Shortcut member; shared tokens also share the
  same Story owner identity.
- Comments identify the agent run but are not locks and are not used as the sole
  readiness source.
- Mutating requests are not blindly retried after ambiguous network failures.
- HTTP 429 responses are retried according to `Retry-After`; safe GET requests
  receive bounded transient retries.
- Shortcut is the only work database. The local JSON file contains configuration,
  not synchronized task state.

## Shortcut as an agent backend

Shortcut is the shared source of truth, which is the point of this CLI — but it
was designed for humans working at human cadence. Nearly every hard part of this
implementation is *emulation*: readiness, mutual exclusion, lease expiry,
attribution, cycle safety, and idempotency are all reconstructed client-side
over plain CRUD. The shortcomings below are the reason those workarounds exist.

**S1 — No conditional writes.** No ETag/`If-Match`, no `If-Unmodified-Since`.

- Every mutation is last-write-wins.
- `start` can only do read → check → PATCH → re-read, which is TOCTOU by
  construction (`src/commands.js`).
- `edit --description` is an unguarded full replace, so two agents appending
  findings clobber each other *silently* — no exit `4`, no warning.

**S2 — Identity is seat-shaped, not machine-shaped.** No bot or service
principal; a token authenticates as one member.

- N agents collapse to 1 Shortcut identity unless you buy N seats.
- Ownership gives mutual exclusion but not attribution.
- The verification read in `start` cannot distinguish winner from loser: both
  agents read back the same member as owner and both conclude they won.
- No per-agent permission scoping, and the shared rate-limit budget cannot be
  partitioned across the fleet.

**S3 — No lease or TTL primitive.** A claim never expires.

- A crashed agent owns a Story forever.
- `claims` has to *infer* liveness from comment timestamps against a client-side
  `--stale-minutes` heuristic.
- Recovery is a human or orchestrator running `release --force`.
- "Reserve with a 15-minute lease, renew by heartbeat, auto-release on expiry"
  has no server-side analogue.

**S4 — Nowhere to put structured agent state.** Custom fields are enum-shaped,
so ephemeral values (`run_id`, event UUIDs) would permanently pollute workspace
schema. Comments became the event log instead (`src/comments.js`).

- The log is unqueryable server-side, so `claims` fans out one comment fetch per
  in-flight Story.
- Comments are editable and deletable by humans, so the log is not
  tamper-evident.
- Versioning is hand-rolled (`EVENT_FORMAT_VERSION`) with no schema validation.
- Every agent event lands in the human activity feed and notification stream,
  with no way to mark a comment machine-generated.

**S5 — The dependency graph is second-class.** A fixed verb set and no graph
queries.

- No server-side cycle detection: `assertNoCycle` pulls every Story in the Epic
  *and* backfills truncated `story_links` per Story to validate one edge.
- Cross-Epic cycle safety is impossible to prove and is explicitly unproven.
- No ready-frontier or topological-order query; `ready` is a full Epic scan
  filtered in memory.
- The verb set is a closed enum (`blocks`, `duplicates`, `relates to`) with no
  extension point: no `discovered-from`, no workspace-defined edge types. Agent
  provenance has nowhere to live but the description.

**S6 — A `blocks` edge is satisfied only by a Done-type state.** There is no way
to say "this edge clears when the blocker reaches In Review".

- Human teams park Stories in a review state; agents cannot, because a Story
  awaiting review still blocks everything downstream. One PR in review stalls
  the whole fleet.
- The only workaround is to have agents `complete` a Story when the PR opens.
  That buys throughput and loses the truth: no review state, wrong cycle-time
  data, and a rejected PR means reopening a Done Story.
- Same root cause as the cancellation problem below — edge satisfaction has
  exactly one predicate, and it is `type == "done"`.

**S7 — Workflow states are configuration, not semantics.**

- `init` guesses meaning from state type plus name regex, pins the resulting
  numeric IDs into config, and needs a whole `doctor` command to detect drift.
- There is no state type for "abandoned", so `cancel` must use a Done-type
  state — which **incorrectly unblocks downstream Stories**. The CLI can only
  warn; the backend makes it unfixable.
- Multi-team Epics get `epicTeams[0]` and a warning, because an Epic has no
  single workflow.

**S8 — No idempotency keys on writes.**

- A non-GET request that fails at the network layer cannot be retried: a
  retried `createStory` duplicates the Story.
- Hence the `ambiguous_mutation` error class in `src/client.js` — the CLI's only
  honest move is to hand the ambiguity to an agent, the worst possible consumer
  of ambiguity.
- `external_id` on comments is not server-enforced, so it supports only
  client-side reconciliation after the fact.

**S9 — Multi-step operations cannot be atomic.**

- Lifecycle commands post a comment then PATCH state: two calls, no transaction.
- `start` explicitly tolerates a successful claim with a failed claim comment,
  producing exactly the `unattributed: true` state `claims` reports.
- Seeding a graph is N Story creates plus M link creates with no rollback.

**S10 — The Epic is the only container this CLI scopes to, and it is not a
namespace.** The weakest item on this list — see the correction below.

- Epics do not nest and carry no permissions or workflow of their own, so the
  unit of agent scope is also the unit of human planning.
- Checklist **Tasks** are not workable units: description, `isCompleted`, and
  owners only. No state, no links, nothing to claim.
- An agent that discovers work needing its own subgraph therefore flattens it
  into the parent Epic, or spawns a sibling Epic and forfeits cycle safety (S5).

*Sub-tasks largely solve this, and this CLI ignores them.* A Shortcut **sub-task
is a full Story** with a parent pointer — its own workflow state, owners, and
story links; detaching one turns it back into an ordinary Story. Hierarchical
decomposition inside a single Epic is available today, with every level
independently claimable. `shortcut-agent` models only `story_links` and never
the parent/child relation, so the flattening above is mostly self-inflicted.
Two things to confirm before leaning on it: how deep sub-tasks may nest, and
whether an incomplete sub-task marks its parent `blocked`. If it does not, a
parent Story can be handed to an agent while its children are still open.

**S11 — The query surface forces full scans and N+1s.**

- There is no "unowned, unblocked, unstarted, in Epic X" query, so every command
  fetches all Epic Stories plus all workflow states.
- `blocked` fetches one Story per blocker; `claims` fetches comments per
  in-flight Story; `dep add` fetches the whole Epic.
- Combined with a fleet-shared rate limit and poll-only discovery, throughput is
  bounded by request budget rather than by available work.

**S12 — `position` is being used as priority.** It is a UI drag-order field: no
atomic reorder, no priority semantics. Adequate for deterministic ordering,
wrong as a scheduler input.

## Suggested Shortcut changes

Ordered by leverage. Most build on entities Shortcut already has.

1. **Free-text and JSON custom field types** *(S4, S3, S12)* — the single
   highest-leverage change. Enum-only custom fields are what pushed agent state
   into comments. A JSON-valued field per Story would hold `agent_id`,
   `run_id`, `lease_expires_at`, and priority as queryable data instead of
   Markdown that has to be regex-parsed back out.
2. **`If-Match` / `If-Unmodified-Since` on `PATCH /stories`** *(S1, S2)* — plain
   HTTP conditional requests, as GitHub and Stripe already expose. This alone
   turns `start` from best-effort into a real compare-and-swap and makes
   description appends safe. Return `412` and the CLI's existing exit `4` path
   handles it.
3. **`Idempotency-Key` request header** *(S8, S9)* — the Stripe pattern.
   Replaying a key returns the original response, so `ambiguous_mutation` stops
   being unrecoverable and `create`/`comment` become safely retryable.
4. **A per-edge or per-workflow "unblocks at" threshold** *(S6)* — let a
   `blocks` edge clear when the blocking Story reaches a nominated state rather
   than only a Done-type one. Workflow states already carry an ordered
   `position`, so "satisfied at *In Review* or later" needs no new concept, just
   a setting. This is what forces agents to falsely complete Stories at PR-open
   time today, and it is the difference between a fleet that stalls on review
   and one that does not.
5. **A `cancelled` workflow state type** *(S7)* — distinct from `done`, and
   explicitly *not* satisfying `blocks` edges. Today cancelling a Story falsely
   unblocks its dependents. Together with (4) this makes edge satisfaction a
   real predicate instead of one hardcoded type check. Correctness fix, not a
   convenience.
6. **Server-side readiness and cycle checks on the Epic** *(S5, S11)* — e.g.
   `GET /epics/{id}/stories?ready=true` returning the unowned, unblocked,
   not-archived frontier, and rejecting a `story-links` POST that would create a
   cycle. Beads treats ready-work as a first-class query (`bd ready`) rather
   than something each client recomputes; both of these are already computed
   client-side here, just expensively.
7. **A bot/service member type** *(S2)* — a non-billable identity with a scoped
   token, so a fleet gets per-agent ownership, attribution, permissions, and
   rate-limit budget. Shortcut already models members and tokens; this is a new
   member *kind*, not a new concept.
8. **Machine-visibility flag on comments** *(S4)* — one boolean that suppresses
   notifications and lets the UI collapse agent chatter, so an event log in
   comments stops being notification spam for human watchers.
9. **An extensible `story-link` verb set** *(S5)* — `blocks`, `duplicates`, and
   `relates to` already exist; the gap is that the enum is closed. Adding
   `discovered-from` would cover the common agent case: Beads carries discovery
   provenance as an edge type, which is how an agent records "this work came out
   of that work" without polluting descriptions.
10. **Transactional graph seeding** *(S9)* — extend bulk story creation to
    accept inter-Story links within one payload, applied atomically. Removes the
    half-built-graph failure mode from `plan apply`.
11. **Server-side lease expiry** *(S3)* — the one item with no existing Shortcut
    pattern to build on, and it may not belong in a product built for humans.
    If (1) lands, a `lease_expires_at` JSON field plus a filterable query gets
    most of the value with no new primitive; true auto-release is the
    SQS-visibility-timeout model, and Beads gets it for free from owning its own
    database.

## Near-term roadmap

- sub-task support, so a discovered subgraph can nest under its parent Story
  instead of flattening into the Epic (see S10)
- `plan apply` for validating and bulk-creating a JSON/YAML Story DAG
- optional explicitly managed `Active Agent` custom field
- richer graph output (adjacency JSON, Mermaid, and DOT)
- audit checks for orphaned work and cross-Epic dependency health
- pinned v4 OpenAPI fixtures and automated schema drift checks
