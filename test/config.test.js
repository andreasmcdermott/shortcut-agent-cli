import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

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
