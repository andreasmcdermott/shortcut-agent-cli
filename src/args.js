import { argumentError } from "./errors.js";

const SHORT_OPTIONS = new Map([
  ["-h", "help"],
  ["-V", "version"],
]);

const BOOLEAN_OPTIONS = new Set([
  "help",
  "version",
  "human",
  "pretty",
  "include-assigned",
  "all-comments",
  "clear-estimate",
  "clear-team",
  "force",
  "merge",
  "update-discovered",
  "release",
  "allow-cross-epic",
]);

function addOption(options, key, value) {
  if (Object.hasOwn(options, key)) {
    options[key] = Array.isArray(options[key])
      ? [...options[key], value]
      : [options[key], value];
  } else {
    options[key] = value;
  }
}

export function parseArgv(argv) {
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (SHORT_OPTIONS.has(token)) {
      addOption(options, SHORT_OPTIONS.get(token), true);
      continue;
    }
    if (token.startsWith("--no-") && token.length > 5) {
      addOption(options, token.slice(5), false);
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (!body) throw argumentError("Invalid empty option");
      const equals = body.indexOf("=");
      if (equals >= 0) {
        addOption(options, body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (BOOLEAN_OPTIONS.has(body)) {
        addOption(options, body, true);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        addOption(options, body, next);
        index += 1;
      } else {
        addOption(options, body, true);
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw argumentError(`Unknown short option: ${token}`);
    }
    positionals.push(token);
  }

  return {
    command: positionals[0] ?? (options.help ? "help" : undefined),
    subcommand: positionals[1],
    args: positionals.slice(1),
    options,
  };
}

export function option(options, key, fallback) {
  const value = options[key];
  if (Array.isArray(value)) return value.at(-1);
  return value === undefined ? fallback : value;
}

export function flag(options, key, fallback = false) {
  const value = option(options, key, fallback);
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return Boolean(value);
}

export function text(options, key, fallback) {
  const value = option(options, key, fallback);
  return typeof value === "boolean" ? fallback : value;
}

export function values(options, key) {
  const raw = options[key];
  if (raw === undefined || raw === false) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function integer(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw argumentError(`${label} is required`);
    return undefined;
  }
  if (typeof value === "boolean") {
    throw argumentError(`${label} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw argumentError(`${label} must be a positive integer`, { value });
  }
  return parsed;
}

export function storyIds(options, key) {
  return values(options, key).map((value) => integer(value, `--${key}`));
}

export function requirePositional(parsed, index, label) {
  const value = parsed.args[index];
  if (value === undefined) throw argumentError(`${label} is required`);
  return value;
}
