import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configError } from "./errors.js";
import { integer, option } from "./args.js";

export const CONFIG_FILENAME = ".shortcut-agent.json";

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(startDirectory = process.cwd(), explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  let directory = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(directory, CONFIG_FILENAME);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function readConfig(filename) {
  if (!filename) return {};
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    throw configError(`Could not read config: ${filename}`, {
      reason: error.message,
    });
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("configuration must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw configError(`Invalid JSON config: ${filename}`, {
      reason: error.message,
    });
  }
}

export async function loadConfig(options, env = process.env, cwd = process.cwd()) {
  const filename = await findConfig(cwd, option(options, "config"));
  const file = await readConfig(filename);

  const epicValue =
    option(options, "epic") ?? env.SHORTCUT_EPIC_ID ?? file.epic_id;
  const config = {
    filename,
    apiUrl:
      option(options, "api-url") ??
      env.SHORTCUT_API_URL ??
      file.api_url ??
      "https://api.app.shortcut.com",
    token: env.SHORTCUT_API_TOKEN,
    workspace:
      option(options, "workspace") ?? env.SHORTCUT_WORKSPACE ?? file.workspace,
    epicId:
      epicValue === undefined ? undefined : integer(epicValue, "Epic ID"),
    teamId:
      option(options, "team") ?? env.SHORTCUT_TEAM_ID ?? file.team_id,
    agentId:
      option(options, "agent") ?? env.SHORTCUT_AGENT_ID ?? file.agent_id,
    runId: env.SHORTCUT_AGENT_RUN_ID,
    states: {
      ready: file.states?.ready,
      started: file.states?.started,
      done: file.states?.done,
      cancelled: file.states?.cancelled,
    },
    raw: file,
  };

  for (const state of ["ready", "started", "done", "cancelled"]) {
    const override = option(options, `${state}-state`);
    if (override !== undefined) {
      config.states[state] = integer(override, `${state} state ID`);
    }
  }
  return config;
}

export function requireToken(config) {
  if (!config.token) {
    throw configError("SHORTCUT_API_TOKEN is required");
  }
  return config.token;
}

export function requireWorkspace(config) {
  if (!config.workspace) {
    throw configError(
      "Shortcut workspace is not configured; run `shortcut-agent init --epic ID --agent ID`",
    );
  }
  return config.workspace;
}

export function requireEpic(config) {
  if (!config.epicId) {
    throw configError("An Epic is required; pass --epic ID or run init");
  }
  return config.epicId;
}

export function requireAgent(config) {
  if (!config.agentId) {
    throw configError(
      "Agent identity is required; pass --agent, set SHORTCUT_AGENT_ID, or run init",
    );
  }
  return config.agentId;
}

export function requireState(config, name) {
  const value = config.states[name];
  if (!value) {
    throw configError(
      `The ${name} workflow state is not configured; run init or pass --${name}-state`,
    );
  }
  return value;
}

export async function writeConfig(filename, config) {
  const target = path.resolve(filename ?? path.join(process.cwd(), CONFIG_FILENAME));
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return target;
}
