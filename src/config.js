import {
  access,
  chmod,
  link,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { configError, argumentError } from "./errors.js";
import { flag, integer, option, text } from "./args.js";

export const CONFIG_FILENAME = ".shortcut-agent.json";
export const LOCAL_CONFIG_FILENAME = ".shortcut-agent.local.json";

const execFileAsync = promisify(execFile);

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function sourceFor(filename, cwd) {
  return path.dirname(filename) === path.resolve(cwd) ? "cwd" : "ancestor";
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function discoveryBoundary(startDirectory) {
  const start = path.resolve(startDirectory);
  let directory = start;
  while (true) {
    if (await exists(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const home = path.resolve(homedir());
  return isWithin(home, start) ? home : start;
}

async function discoverConfig(startDirectory) {
  let directory = path.resolve(startDirectory);
  const boundary = await discoveryBoundary(directory);
  while (true) {
    const candidate = path.join(directory, CONFIG_FILENAME);
    if (await exists(candidate)) return candidate;
    if (directory === boundary) return undefined;
    directory = path.dirname(directory);
  }
}

export async function findConfig(startDirectory = process.cwd(), explicitPath) {
  if (explicitPath) return path.resolve(startDirectory, explicitPath);
  return discoverConfig(startDirectory);
}

async function readConfigResult(filename, { mayNotExist = false } = {}) {
  if (!filename) return { value: {}, exists: false };
  let content;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    if (mayNotExist && error.code === "ENOENT") {
      return { value: {}, exists: false };
    }
    throw configError(`Could not read config: ${filename}`, {
      reason: error.message,
    });
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("configuration must be a JSON object");
    }
    return { value: parsed, exists: true };
  } catch (error) {
    throw configError(`Invalid JSON config: ${filename}`, {
      reason: error.message,
    });
  }
}

export async function readConfig(filename, options) {
  return (await readConfigResult(filename, options)).value;
}

function explicitConfig(options, env, cwd) {
  const commandValue = option(options, "config");
  if (commandValue === true) {
    throw argumentError("--config requires a value");
  }
  if (commandValue !== undefined && commandValue !== false) {
    return { filename: path.resolve(cwd, String(commandValue)), source: "explicit" };
  }
  if (env.SHORTCUT_AGENT_CONFIG) {
    return {
      filename: path.resolve(cwd, env.SHORTCUT_AGENT_CONFIG),
      source: "env",
    };
  }
  return undefined;
}

export async function loadConfig(
  options,
  env = process.env,
  cwd = process.cwd(),
  { forInit = false } = {},
) {
  const explicit = explicitConfig(options, env, cwd);
  let resolution = explicit;

  if (!resolution && forInit && !flag(options, "update-discovered")) {
    resolution = {
      filename: path.join(path.resolve(cwd), CONFIG_FILENAME),
      source: "cwd",
    };
  }
  if (!resolution) {
    const discovered = await discoverConfig(cwd);
    if (discovered) {
      resolution = { filename: discovered, source: sourceFor(discovered, cwd) };
    } else if (forInit) {
      resolution = {
        filename: path.join(path.resolve(cwd), CONFIG_FILENAME),
        source: "cwd",
      };
    }
  }

  const filename = resolution?.filename;
  const fileResult = await readConfigResult(filename, { mayNotExist: forInit });
  const file = fileResult.value;
  const fileExists = fileResult.exists;
  const localCandidate = filename
    ? path.join(path.dirname(filename), LOCAL_CONFIG_FILENAME)
    : undefined;
  const localFilename = localCandidate && (await exists(localCandidate))
    ? localCandidate
    : undefined;
  const local = await readConfig(localFilename);
  const merged = {
    ...file,
    ...local,
    states: { ...file.states, ...local.states },
  };

  const commandAgent = option(options, "agent");
  const environmentAgent = env.SHORTCUT_AGENT_ID;
  const agentId =
    commandAgent ?? environmentAgent ?? local.agent_id ?? file.agent_id;
  const agentSource =
    commandAgent !== undefined
      ? "command"
      : environmentAgent !== undefined
        ? "environment"
        : local.agent_id !== undefined
          ? "local-config"
          : file.agent_id !== undefined
            ? "project-config"
            : undefined;

  const epicValue =
    option(options, "epic") ?? env.SHORTCUT_EPIC_ID ?? merged.epic_id;
  const config = {
    filename,
    source: resolution?.source ?? "none",
    exists: fileExists,
    localFilename,
    apiUrl:
      text(options, "api-url") ??
      env.SHORTCUT_API_URL ??
      merged.api_url ??
      "https://api.app.shortcut.com",
    token: env.SHORTCUT_API_TOKEN,
    workspace:
      text(options, "workspace") ?? env.SHORTCUT_WORKSPACE ?? merged.workspace,
    epicId:
      epicValue === undefined ? undefined : integer(epicValue, "Epic ID"),
    teamId: text(options, "team") ?? env.SHORTCUT_TEAM_ID ?? merged.team_id,
    agentId,
    agentSource,
    runId: env.SHORTCUT_AGENT_RUN_ID,
    states: {
      ready: merged.states?.ready,
      started: merged.states?.started,
      done: merged.states?.done,
      cancelled: merged.states?.cancelled,
    },
    raw: file,
    localRaw: local,
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
      "Shortcut workspace is not configured; run `shortcut-agent init --epic ID`",
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
  if (!config.agentId || config.agentId === true) {
    throw configError(
      "Agent identity is required; pass --agent, set SHORTCUT_AGENT_ID, or use an ignored local config",
    );
  }
  return String(config.agentId);
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

async function acquireWriteLock(target) {
  const lockFilename = `${target}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockFilename, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockFilename, { force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockFilename, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockFilename);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          const staleFilename = `${lockFilename}.${randomUUID()}.stale`;
          try {
            await rename(lockFilename, staleFilename);
            await rm(staleFilename, { force: true });
          } catch (renameError) {
            if (renameError.code !== "ENOENT") throw renameError;
          }
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      await delay(25);
    }
  }
  throw configError(`Timed out waiting to write config: ${target}`, {
    config_file: target,
  });
}

export async function writeConfig(
  filename,
  config,
  { overwrite = true, expected } = {},
) {
  const requestedTarget = path.resolve(
    filename ?? path.join(process.cwd(), CONFIG_FILENAME),
  );
  const releaseLock = await acquireWriteLock(requestedTarget);
  let temporary;
  try {
    let target = requestedTarget;
    if (overwrite) {
      try {
        target = await realpath(requestedTarget);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    let mode = 0o644;
    if (overwrite) {
      try {
        mode = (await stat(target)).mode & 0o7777;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    await chmod(temporary, mode);
    if (overwrite) {
      if (expected !== undefined) {
        const current = await readConfig(requestedTarget);
        if (!isDeepStrictEqual(current, expected)) {
          throw configError(`Config changed while init was running: ${requestedTarget}`, {
            config_file: requestedTarget,
          });
        }
      }
      await rename(temporary, target);
    } else {
      try {
        await link(temporary, requestedTarget);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw configError(
            `Config appeared while init was running: ${requestedTarget}`,
            { config_file: requestedTarget },
          );
        }
        throw error;
      }
      await rm(temporary);
    }
    temporary = undefined;
    return requestedTarget;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    await releaseLock();
  }
}

export async function isGitIgnored(filename) {
  try {
    await execFileAsync(
      "git",
      ["-C", path.dirname(filename), "check-ignore", "--quiet", "--", filename],
      { windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}
