---
name: shortcut-agent
description: Coordinate a group of agents through the `shortcut-agent` CLI, which stores work as a dependency graph of Shortcut Stories inside an Epic. Use when claiming, implementing, or completing work with shortcut-agent; when seeding or maintaining a work graph; when running orchestrator/worker agent fleets against a Shortcut Epic; or when a `.shortcut-agent.json` is present in the project.
---

# Working as a fleet with `shortcut-agent`

`shortcut-agent` turns a Shortcut Epic into a shared work queue with dependency
edges. Every agent reads and writes the same graph, so the graph — not the chat
transcript — is the coordination medium.

| Concept | Shortcut primitive |
| --- | --- |
| Work graph | Epic |
| Work item | Story |
| Blocking edge | Story Link, verb `blocks` |
| Soft edge | Story Link, verb `relates to` |
| Claim | Story Owner + a `claim` comment |
| Lifecycle | Workflow State (ready / started / done / cancelled) |
| Agent attribution | Structured `shortcut-agent` JSON in comments |

Output is JSON on stdout. Parse it. Add `--pretty` while debugging, `--human`
only when reporting to a person.

## Inside bb

When the Shortcut Agent bb plugin is installed, prefer its native tools when
they are available:

- `shortcut_agent_context`, `shortcut_agent_show`
- `shortcut_agent_create`, `shortcut_agent_edit`, `shortcut_agent_add_dependency`
- `shortcut_agent_start`, `shortcut_agent_complete`, `shortcut_agent_release`

Native arguments are schema-validated and the plugin reads its Shortcut token
server-side, so the token never enters the agent environment or shell. The
mutation tools appear only when the user enables **Enable agent mutations** in
the plugin settings.

For workflows without a dedicated tool, use the registered server-side command:

```sh
bb shortcut-agent ready
bb shortcut-agent blocked
bb shortcut-agent claims --stale
bb shortcut-agent handoff 456 --summary 'Parser implemented' --release
```

`bb shortcut-agent` automatically resolves `.shortcut-agent.json` from the
invoking bb project. It intentionally does not support `init`, `--config`,
`--api-url`, or `--description-file`; use the standalone CLI for initialization
and pass inline description text from bb. Lifecycle calls derive agent identity from the current
bb thread unless an explicit `agentId` / `--agent` is supplied.

## The five facts that determine correct behavior

Read these before designing any fleet. They are verified against the
implementation, and each one changes what the protocol has to look like.

1. **A shared token means a shared owner.** The token authenticates as one
   Shortcut member. If every agent uses the same `SHORTCUT_API_TOKEN`, every
   claim is owned by the same member. Ownership therefore gives you *mutual
   exclusion* but not *identity*. The only record of which agent holds a Story
   is the `agent_id` inside its `claim` comment — which is what `claims` reads
   back for you.

2. **`ready` already hides claimed work.** A Story is ready only when it is in
   the Epic, not archived, in a `backlog`/`unstarted` state, has
   `blocked: false`, and **has no owner**. So `ready` is a safe queue to poll —
   claiming a Story removes it from everyone else's queue.

3. **Claims can still race.** Shortcut has no compare-and-swap. `start` checks
   preconditions, writes, then re-reads to verify, but two agents can interleave.
   Exit code `4` (`claim_conflict`) is *normal contention*, not a failure. Either
   serialize claims through one orchestrator, or have workers retry on `4`.

4. **The description is the entire handoff.** The agent that implements a Story
   usually has no shared context with the agent that wrote it. A Story whose
   description does not stand alone is a Story that will be implemented wrong.

5. **Cycle safety is only checked for same-Epic `blocks` edges.** Cross-Epic
   edges require `--allow-cross-epic` and are explicitly unproven. Keep one
   graph in one Epic whenever you can.

## Setup

```sh
export SHORTCUT_API_TOKEN='sct_rw_...'
shortcut-agent init --epic 12345
shortcut-agent doctor
```

`init` writes shared scope (workspace, default Epic, team, state IDs) to
`.shortcut-agent.json` in cwd, which is safe to commit. It never writes the
token. It will not reuse an ancestor config or overwrite a differing target by
default: use `--update-discovered` to target a bounded discovered ancestor,
`--merge` to preserve extra keys while refreshing known fields, or `--force` to
replace the target. Successful output includes `config_file` and
`config_source`; check both when orchestrating setup.

Treat `epic_id` as a convenience default. In a repository serving multiple
Epics, initialize with `--no-default-epic` and pass `--epic ID` on every
Epic-scoped command.

Give **every process its own identity**. Do not rely on a local default when
running in parallel:

```sh
export SHORTCUT_AGENT_ID='worker-3'          # stable worker slot
export SHORTCUT_AGENT_RUN_ID="$(uuidgen)"    # this session only
```

Without a distinct `SHORTCUT_AGENT_ID`, comment attribution collapses and you
lose the only signal that tells claims apart (fact 1).

## Choose an operating mode

Scope options never mutate. `--epic` and `--team` select what a command operates
on; moving a Story requires the explicit `--move-to-epic` / `--set-team` flags on
`edit`. A value-taking flag passed with no value is a hard error rather than a
silent default, so an unset shell variable fails loudly instead of targeting the
wrong Epic.

**Mode A — Orchestrated claims (default; use when strict exclusion matters).**
One orchestrator owns claiming. It calls `start` on behalf of a worker, passing
that worker's identity so attribution stays correct, then hands the Story ID to
the worker:

```sh
shortcut-agent start 456 --agent worker-3
```

The worker never calls `start`. Races are impossible because one process
serializes every claim.

**Mode B — Autonomous pool (use for loosely coupled fleets).** Workers poll
`ready` and self-claim, treating exit `4` as contention. To avoid a thundering
herd, **workers must not all take the first ready Story** — offset the pick by
worker index:

```sh
# worker N of M: take the Nth ready story, fall through on conflict
shortcut-agent ready | jq -r --argjson n "$WORKER_INDEX" '.stories[$n:][].id' |
while read -r id; do
  if shortcut-agent start "$id"; then echo "claimed $id"; break; fi
done
```

## Roles

Split responsibilities so that graph *shape* has a single author while graph
*execution* scales out.

### Orchestrator — one per Epic, owns the graph

- Seeds the initial graph and keeps `context` in view.
- Owns every edge between Stories it did not author moments ago: all
  `dep add` / `dep remove` between existing nodes.
- Triages worker-created Stories: fixes thin descriptions, attaches the edges
  the worker could not see, merges duplicates.
- Owns `cancel`, and owns all `--force` recovery of stale claims.
- Decides when the Epic is finished.

### Worker — N in parallel, owns one node at a time

- Claims one Story, implements it, sends it to review with `complete`.
- May create work **only at its own node** (see the locality rule).
- `handoff`s rather than dying silently when out of context or blocked.
- Never runs `cancel`, never runs `--force`, never edits edges between Stories
  it does not hold.

### Reviewer — optional

`complete` moves implementation to the configured Review state by default, so
human review can follow the normal Shortcut workflow. If review itself should
be autonomous, claimable work, model it as a separate *Story* and relate it to
the implementation without relying on the implementation Story to unblock it.

## The locality rule

> **An agent may only mutate the graph at the node it holds.**

This is what keeps N parallel writers from corrupting a shared graph. Concretely,
a worker holding Story 456 may:

- `edit 456`, `handoff 456`, `complete 456`, `release 456`
- `create` a Story with `--blocks 456` (a newly discovered blocker)
- `create` a Story with `--blocked-by 456` (follow-up work it unblocks)
- `create` a Story with `--related-to 456` (adjacent, non-blocking)

It may **not** add an edge between two Stories it does not hold, cancel anything,
or touch another agent's claim. Those go to the orchestrator — as a comment on
its own Story, or a `related-to` Story describing the needed change.

## Core loops

### Worker loop

```sh
shortcut-agent ready --pretty          # 1. find work (already excludes claims)
shortcut-agent show 456                # 2. read description + prior agent events
shortcut-agent start 456               # 3. claim (Mode B only); exit 4 = re-pick
# ... implement ...
shortcut-agent complete 456 \
  --summary 'Implemented cache invalidation on write path' \
  --verification 'npm test -- cache' \
  --evidence 'https://github.com/acme/repo/pull/123'
```

Always `show` before starting work. The comment stream carries `agent_event`
objects from prior claims and handoffs — that is where a previous agent's
partial progress lives.

### Discovering work mid-implementation

This is the case the graph exists for. Three shapes:

**A blocker you must resolve first** — create it, point it *at* your Story, and
release yours back to the pool. It will not be re-served until the blocker is
done, because `blocked: true` excludes it from `ready`:

```sh
shortcut-agent create \
  --title 'Add tenant ID to cache key schema' \
  --description-file ./blocker.md \
  --blocks 456

shortcut-agent handoff 456 \
  --summary 'Blocked: cache key schema must carry tenant ID first' \
  --changed 'src/cache.js' \
  --remaining 'Resume invalidation once the schema Story lands' \
  --release
```

**Follow-up work your Story enables** — create it and keep going:

```sh
shortcut-agent create --title 'Backfill cache metrics' \
  --description-file ./followup.md --blocked-by 456
```

**Adjacent work someone else should judge** — create it `--related-to 456` and
let the orchestrator decide whether it becomes a blocker.

### Pausing without losing progress

```sh
shortcut-agent handoff 456 \
  --summary 'Parser implemented; integration remains' \
  --changed 'src/parser.js,test/parser.test.js' \
  --verification 'npm test -- parser' \
  --remaining 'Wire parser into the command dispatcher' \
  --release
```

Without `--release` the Story stays claimed and the comment is just a progress
note. With `--release` it returns to the ready pool for anyone. Write
`--remaining` as an instruction to a stranger, because that is who reads it.

### Orchestrator loop

```sh
shortcut-agent context --pretty   # counts + ready/active/blocked/other/recent
shortcut-agent blocked --pretty   # each blocked Story with its blockers inlined
shortcut-agent claims --stale     # in-flight work nobody has touched recently
```

`blocked` resolves and inlines the blocker Stories, so it tells you directly
whether the graph is stalled on real work or on a bad edge. If `ready` is empty
and `blocked` is not, the critical path is the blocker set — schedule that first.

### Recovering stale claims

A worker that dies holding a claim removes its Story from the queue permanently:
it is owned, so `ready` skips it, and nothing times it out. `claims` is how you
find that:

```sh
shortcut-agent claims                          # everything in flight, with holders
shortcut-agent claims --stale --stale-minutes 45
shortcut-agent claims --mine                   # what do I hold? (survives a restart)
```

Each entry reports `agent_id`, `claimed_at`, `last_event`, `idle_minutes`, and
`stale`. `unattributed: true` means the Story is held but has no claim comment —
claimed outside the CLI, or a claim whose comment write failed.

`claims` is read-only. Recover with the ordinary lifecycle command, which
returns the Story to the ready pool:

```sh
shortcut-agent release 456 --reason 'Reclaiming stale claim from worker-2' --force
```

Only the orchestrator does this. Idle time is not proof of death — confirm the
holder is really gone before reclaiming, or two agents will edit the same code.

## Writing a Story that another agent can execute

Descriptions are required at create time precisely so ready work is
self-contained. Use this structure:

```markdown
## Goal
One sentence: what must be true when this is done.

## Context
Why this exists and what decision has already been made. Link the ADR/PR/thread.

## Acceptance criteria
- [ ] Observable, checkable statements — not implementation steps.

## Verification
The exact command that proves it: `npm test -- cache`

## Pointers
src/cache.js:88 — current key construction
```

Pass it with `--description-file ./story.md`, or pipe it:

```sh
printf '%s' "$BODY" | shortcut-agent create --title 'Implement cache keys' --description-file -
```

Inline `--description 'text'` is fine for one-liners. `--description` and
`--description-file` are mutually exclusive.

## Maintaining the graph

`create` accepts repeated or comma-separated relation flags. **`dep` does not —
it takes exactly one relation per invocation.** This is the most common
mechanical error:

```sh
shortcut-agent dep add 456 --blocked-by 41      # correct
shortcut-agent dep add 456 --blocked-by 41,42   # error: exactly one required
```

`dep add` is idempotent: re-adding an existing edge returns `unchanged: true`
rather than erroring, so retries are safe. Adding a same-Epic `blocks` edge that
would close a cycle fails with `dependency_cycle` before anything is written.

Direction is stated from the subject's point of view:

- `--blocked-by 41` — 41 blocks this Story
- `--blocks 72` — this Story blocks 72
- `--related-to 19` — non-blocking

**Cancelling is a graph operation, not a cleanup.** `cancel` moves to a
Done-type state, which *unblocks everything downstream*. If the downstream work
only made sense given the cancelled Story, it is now ready and wrong. Cancel a
blocker only after checking `blocks` in its summary — the CLI warns you when the
Story had dependents.

## Exit codes are the control flow

| Exit | Meaning | Fleet response |
| --- | --- | --- |
| `0` | Success, including an empty `ready` | Empty `ready` is not an error — check `blocked` |
| `2` | Invalid arguments | Fix the command; do not retry |
| `3` | Missing/invalid configuration | Stop; run `doctor`. Retrying will not help |
| `4` | Claim/state/dependency conflict | Expected under contention — re-pick and continue |
| `5` | Auth failure | Stop the fleet; the token is bad or lacks access |
| `6` | Shortcut API/network failure | Back off and retry reads; do **not** blindly retry mutations |

Exit `4` covers `claim_conflict`, `story_blocked`, `invalid_story_state`,
`ownership_conflict`, `dependency_cycle`, `cross_epic_dependency`, and
`story_outside_epic`. Read `error.code` to tell contention from a real modeling
mistake — `claim_conflict` means try another Story, `dependency_cycle` means the
plan is wrong.

## Failure modes to avoid

- **Every worker sharing one `SHORTCUT_AGENT_ID`.** Attribution collapses and
  stale claims become unattributable. Give each slot its own ID.
- **All workers claiming `ready[0]`.** Guaranteed collisions every round. Offset
  by worker index.
- **Treating exit `4` as fatal.** It is the expected outcome of a lost race.
- **Workers rewiring the graph.** Concurrent edge edits produce a shape nobody
  designed. Honor the locality rule.
- **Thin descriptions.** The implementing agent cannot ask follow-up questions.
- **Dying while holding a claim.** The Story stays owned and leaves the queue
  forever. Always `handoff --release` on the way out; the orchestrator finds the
  rest with `claims --stale` and recovers them with `release --force`.
- **Retrying a mutation after an ambiguous network error.** The CLI deliberately
  does not. Re-read with `show` and decide from actual state.

## References

- `references/commands.md` — full verified command and flag reference
- `references/roles.md` — copy-pasteable orchestrator and worker role prompts
