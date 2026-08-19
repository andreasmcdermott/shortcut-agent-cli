import { parseArgv, flag } from "./args.js";
import {
  loadConfig,
  requireToken,
  requireWorkspace,
} from "./config.js";
import { ShortcutClient } from "./client.js";
import { executeCommand } from "./commands.js";
import { argumentError, toErrorPayload } from "./errors.js";
import { commandHelp, globalHelp } from "./help.js";

export const VERSION = "0.1.0";

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
      const helpCommand = parsed.command === "help" ? parsed.args[0] : parsed.command;
      const helpSubcommand =
        parsed.command === "help" ? parsed.args[1] : parsed.subcommand;
      const help = helpCommand
        ? commandHelp(helpCommand, helpSubcommand)
        : globalHelp(VERSION);
      if (!help) {
        const topic = [helpCommand, helpSubcommand].filter(Boolean).join(" ");
        throw argumentError(`Unknown help topic: ${topic}`);
      }
      stdout.write(`${help}\n`);
      return 0;
    }
    if (parsed.command === "version" || flag(parsed.options, "version")) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }

    const config = await loadConfig(parsed.options, env, cwd);
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
    const payload = await executeCommand(parsed, {
      config,
      client,
      makeClient,
      cwd,
      stdin,
      env,
    });
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
