import { parseArgv, flag } from "./args.js";
import {
  loadConfig,
  requireToken,
  requireWorkspace,
} from "./config.js";
import { ShortcutClient } from "./client.js";
import { executeCommand } from "./commands.js";
import { toErrorPayload } from "./errors.js";

export const VERSION = "0.1.0";

const HELP = `shortcut-agent ${VERSION}

Agent-first Shortcut work coordination.

Usage:
  shortcut-agent init --epic ID [--team UUID] [--workflow ID] [state options]
  shortcut-agent config
  shortcut-agent doctor
  shortcut-agent create --title TITLE --description TEXT [relations]
  shortcut-agent list [--epic ID]
  shortcut-agent ready [--include-assigned]
  shortcut-agent blocked
  shortcut-agent show STORY [--all-comments]
  shortcut-agent edit STORY [field options]
  shortcut-agent start STORY
  shortcut-agent complete STORY --summary TEXT [--verification TEXT]
  shortcut-agent cancel STORY --reason TEXT
  shortcut-agent release STORY --reason TEXT
  shortcut-agent handoff STORY --summary TEXT [--release]
  shortcut-agent dep add|remove STORY --blocked-by|--blocks|--related-to OTHER
  shortcut-agent claims [--mine|--held-by ID] [--stale] [--stale-minutes N]
  shortcut-agent context

Global options:
  --config PATH       Select a config file
  --api-url URL       Override the Shortcut API URL
  --workspace SLUG    Override workspace
  --epic ID           Override the configured Epic
  --team UUID         Override the configured Team
  --agent ID          Override the stable agent identity
  --human             Concise human-readable output
  --pretty            Indented JSON output
  -h, --help          Show help
  -V, --version       Show version

Init options:
  --workflow ID       Use this Workflow instead of the team's default
  --ready-state ID    Explicit state override (also started/done/cancelled)
  --agent ID          Save a local default agent identity
  --merge             Update known fields while preserving extra config keys
  --force             Replace an existing config instead of refusing changes
  --update-discovered Update the bounded ancestor config instead of cwd

Edit mutations (distinct from the scope options above):
  --move-to-epic ID   Move the Story to another Epic
  --set-team [UUID]   Set the Story team, defaulting to the configured team
  --clear-team        Remove the Story team

Create relations:
  --blocked-by ID     Existing Story blocks this Story (repeatable)
  --blocks ID         This Story blocks an existing Story (repeatable)
  --related-to ID     Non-blocking relation (repeatable)

See README.md for the complete behavioral contract and configuration reference.`;

function humanStory(story) {
  const state = story.state?.name ?? story.state?.type ?? "unknown";
  const owner = story.owners?.map((item) => item.name).join(", ") || "unowned";
  return `sc-${story.id} [${state}] ${story.title} (${owner})`;
}

function formatHuman(payload) {
  if (payload.command === "ready" || payload.command === "list" || payload.command === "blocked") {
    if (!payload.stories.length) return `No ${payload.command} Stories in Epic ${payload.epic_id}.`;
    return payload.stories.map(humanStory).join("\n");
  }
  if (payload.story) return humanStory(payload.story);
  if (payload.command === "context") {
    return [
      `Epic ${payload.epic.id}: ${payload.epic.name}`,
      `Ready ${payload.counts.ready} | Active ${payload.counts.active} | Blocked ${payload.counts.blocked} | Done ${payload.counts.done}`,
      ...payload.ready.map((story) => `READY ${humanStory(story)}`),
      ...payload.active.map((story) => `ACTIVE ${humanStory(story)}`),
      ...payload.blocked.map((story) => `BLOCKED ${humanStory(story)}`),
    ].join("\n");
  }
  if (payload.command === "claims") {
    if (!payload.claims.length) return `No matching claims in Epic ${payload.epic_id}.`;
    return payload.claims
      .map((claim) => {
        const holder = claim.agent_id ?? "unattributed";
        const idle = claim.idle_minutes === null ? "?" : `${claim.idle_minutes}m`;
        const marker = claim.stale ? " STALE" : "";
        return `${humanStory(claim.story)} held by ${holder}, idle ${idle}${marker}`;
      })
      .join("\n");
  }
  if (payload.command === "doctor") {
    return payload.ok
      ? `Configuration is valid for ${payload.workspace?.slug ?? payload.workspace}.`
      : `Configuration warnings:\n${payload.warnings.map((warning) => `- ${warning}`).join("\n")}`;
  }
  return JSON.stringify(payload, null, 2);
}

function writeJson(stream, payload, pretty) {
  stream.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
}

export async function run(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgv(argv);
    if (parsed.command === "help" || flag(parsed.options, "help")) {
      stdout.write(`${HELP}\n`);
      return 0;
    }
    if (parsed.command === "version" || flag(parsed.options, "version")) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }

    const config = await loadConfig(parsed.options, env, cwd, {
      forInit: parsed.command === "init",
    });
    const makeClient = ({ workspace = config.workspace } = {}) =>
      new ShortcutClient({
        token: requireToken(config),
        workspace,
        baseUrl: config.apiUrl,
        fetchImpl,
      });
    const commandsWithoutWorkspace = new Set(["init", "config"]);
    let client;
    if (!commandsWithoutWorkspace.has(parsed.command)) {
      requireToken(config);
      requireWorkspace(config);
      client = makeClient();
    }
    const commandPayload = await executeCommand(parsed, {
      config,
      client,
      makeClient,
      cwd,
      stdin,
      env,
    });
    const payload = {
      ...commandPayload,
      config_file: commandPayload.config_file ?? config.filename ?? null,
      config_source: commandPayload.config_source ?? config.source,
    };
    if (flag(parsed.options, "human")) stdout.write(`${formatHuman(payload)}\n`);
    else writeJson(stdout, payload, flag(parsed.options, "pretty"));
    return payload.ok === false && parsed.command === "doctor" ? 3 : 0;
  } catch (error) {
    const { payload, exitCode } = toErrorPayload(error);
    writeJson(stderr, payload, flag(parsed?.options ?? {}, "pretty"));
    return exitCode;
  }
}

export async function main(argv) {
  process.exitCode = await run(argv);
}
