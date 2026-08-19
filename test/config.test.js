import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, requireEpic, writeConfig } from "../src/config.js";

async function projectConfig() {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-config-test-"));
  await writeFile(
    path.join(directory, ".shortcut-agent.json"),
    JSON.stringify({
      workspace: "acme",
      epic_id: 99,
      agent_id: "legacy-agent",
      states: { ready: 1, started: 2, done: 3 },
    }),
  );
  await writeFile(
    path.join(directory, ".shortcut-agent.local.json"),
    JSON.stringify({
      agent_id: "local-agent",
      states: { cancelled: 4 },
    }),
  );
  return directory;
}

test("layers ignored local config over shared project scope", async () => {
  const directory = await projectConfig();
  const config = await loadConfig({}, {}, directory);
  assert.equal(config.workspace, "acme");
  assert.equal(config.epicId, 99);
  assert.equal(config.agentId, "local-agent");
  assert.equal(config.agentSource, "local-config");
  assert.deepEqual(config.states, { ready: 1, started: 2, done: 3, cancelled: 4 });
});

test("an explicit Epic works when project config has no default Epic", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-config-test-"));
  await writeFile(
    path.join(directory, ".shortcut-agent.json"),
    JSON.stringify({
      workspace: "acme",
      states: { ready: 1, started: 2, done: 3 },
    }),
  );

  const withoutEpic = await loadConfig({}, {}, directory);
  assert.equal(withoutEpic.epicId, undefined);
  assert.throws(() => requireEpic(withoutEpic), /pass --epic ID/);

  const selected = await loadConfig({ epic: "42" }, {}, directory);
  assert.equal(requireEpic(selected), 42);
});

test("runtime identity overrides local and legacy project identities", async () => {
  const directory = await projectConfig();
  const environment = await loadConfig(
    {},
    { SHORTCUT_AGENT_ID: "environment-agent" },
    directory,
  );
  assert.equal(environment.agentId, "environment-agent");
  assert.equal(environment.agentSource, "environment");

  const command = await loadConfig(
    { agent: "command-agent" },
    { SHORTCUT_AGENT_ID: "environment-agent" },
    directory,
  );
  assert.equal(command.agentId, "command-agent");
  assert.equal(command.agentSource, "command");
});

test("config discovery stops at a Git or linked-worktree boundary", async () => {
  const parent = await projectConfig();
  const repository = path.join(parent, "worktree");
  const nested = path.join(repository, "packages", "api");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(repository, ".git"), "gitdir: /tmp/example\n");

  const config = await loadConfig({}, {}, nested);
  assert.equal(config.filename, undefined);
  assert.equal(config.source, "none");
  assert.equal(config.epicId, undefined);
});

test("outside Git and home, discovery does not inherit arbitrary ancestors", async () => {
  const parent = await projectConfig();
  const nested = path.join(parent, "packages", "api");
  await mkdir(nested, { recursive: true });

  const config = await loadConfig({}, {}, nested);
  assert.equal(config.filename, undefined);
  assert.equal(config.source, "none");
});

test("init resolves its target in cwd instead of reusing a discovered ancestor", async () => {
  const parent = await projectConfig();
  const nested = path.join(parent, "packages", "api");
  await mkdir(nested, { recursive: true });

  const config = await loadConfig({}, {}, nested, { forInit: true });
  assert.equal(config.filename, path.join(nested, ".shortcut-agent.json"));
  assert.equal(config.source, "cwd");
  assert.equal(config.exists, false);
  assert.equal(config.epicId, undefined);
});

test("init permits a missing explicit config while read commands stay strict", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-explicit-test-"));
  const filename = path.join(directory, "custom.json");

  const config = await loadConfig(
    { config: "custom.json" },
    {},
    directory,
    { forInit: true },
  );
  assert.equal(config.filename, filename);
  assert.equal(config.source, "explicit");
  assert.equal(config.exists, false);

  await assert.rejects(loadConfig({ config: "custom.json" }, {}, directory), {
    code: "invalid_configuration",
  });
});

test("SHORTCUT_AGENT_CONFIG selects a config and reports env provenance", async () => {
  const directory = await projectConfig();
  const filename = path.join(directory, ".shortcut-agent.json");
  const config = await loadConfig(
    {},
    { SHORTCUT_AGENT_CONFIG: filename },
    path.join(directory, "elsewhere"),
  );
  assert.equal(config.filename, filename);
  assert.equal(config.source, "env");
});

test("--config takes precedence over SHORTCUT_AGENT_CONFIG", async () => {
  const directory = await projectConfig();
  const commandFilename = path.join(directory, "command.json");
  await writeFile(commandFilename, JSON.stringify({ epic_id: 42 }));
  const config = await loadConfig(
    { config: commandFilename },
    { SHORTCUT_AGENT_CONFIG: path.join(directory, ".shortcut-agent.json") },
    directory,
  );
  assert.equal(config.filename, commandFilename);
  assert.equal(config.source, "explicit");
  assert.equal(config.epicId, 42);
});

test("writeConfig leaves only the atomically replaced target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-write-test-"));
  const filename = path.join(directory, ".shortcut-agent.json");
  await writeConfig(filename, { epic_id: 99 });
  assert.deepEqual(await readdir(directory), [".shortcut-agent.json"]);
});

test("atomic replacement preserves mode even under a restrictive umask", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-mode-test-"));
  const filename = path.join(directory, ".shortcut-agent.json");
  await writeFile(filename, '{"epic_id":99}\n');
  await chmod(filename, 0o764);
  const previousUmask = process.umask(0o077);
  try {
    await writeConfig(filename, { epic_id: 98 }, { expected: { epic_id: 99 } });
  } finally {
    process.umask(previousUmask);
  }
  assert.equal((await stat(filename)).mode & 0o777, 0o764);
});

test("atomic replacement preserves a symlink and destination permissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-symlink-test-"));
  const destination = path.join(directory, "shared.json");
  const filename = path.join(directory, ".shortcut-agent.json");
  await writeFile(destination, '{"epic_id":99}\n');
  await chmod(destination, 0o600);
  await symlink(destination, filename);

  await writeConfig(filename, { epic_id: 98 }, { expected: { epic_id: 99 } });
  assert.equal((await lstat(filename)).isSymbolicLink(), true);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), { epic_id: 98 });
});

test("concurrent replacements serialize stale-snapshot validation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-update-race-test-"));
  const filename = path.join(directory, ".shortcut-agent.json");
  await writeFile(filename, '{"epic_id":99}\n');

  const results = await Promise.allSettled([
    writeConfig(filename, { epic_id: 98 }, { expected: { epic_id: 99 } }),
    writeConfig(filename, { epic_id: 97 }, { expected: { epic_id: 99 } }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejection = results.find(({ status }) => status === "rejected");
  assert.equal(rejection.reason.code, "invalid_configuration");
  assert.match(rejection.reason.message, /changed while init was running/);
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".lock")), false);
});

test("writeConfig can atomically refuse a concurrently created target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-race-test-"));
  const filename = path.join(directory, ".shortcut-agent.json");
  await writeFile(filename, '{"epic_id":99}\n');
  await assert.rejects(
    writeConfig(filename, { epic_id: 98 }, { overwrite: false }),
    { code: "invalid_configuration" },
  );
  assert.equal(await readFile(filename, "utf8"), '{"epic_id":99}\n');
  assert.deepEqual(await readdir(directory), [".shortcut-agent.json"]);
});
