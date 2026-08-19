import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/main.js";

function capture() {
  let text = "";
  return { write: (value) => (text += value), value: () => text };
}

async function runHelp(argv) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await run(argv, {
    env: {},
    stdout,
    stderr,
    fetchImpl: () => {
      throw new Error("help must not call Shortcut");
    },
  });
  return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
}

test("create help explains that new Stories are unowned and Ready", async () => {
  const result = await runHelp(["create", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /Creates an unowned Story in the Ready state; use start to claim it\./,
  );
  assert.match(result.stdout, /--description-file PATH/);
  assert.match(result.stdout, /--blocked-by ID/);
});

test("every command exposes command-specific help without loading config", async () => {
  const commands = [
    ["init"],
    ["config"],
    ["doctor"],
    ["create"],
    ["list"],
    ["ready"],
    ["blocked"],
    ["show"],
    ["edit"],
    ["start"],
    ["complete"],
    ["cancel"],
    ["release"],
    ["handoff"],
    ["dep"],
    ["dep", "add"],
    ["dep", "remove"],
    ["claims"],
    ["context"],
  ];

  for (const command of commands) {
    const result = await runHelp([...command, "--help"]);
    assert.equal(result.exitCode, 0, command.join(" "));
    assert.equal(result.stderr, "", command.join(" "));
    assert.match(result.stdout, /^shortcut-agent /, command.join(" "));
    assert.match(result.stdout, /\nUsage:\n/, command.join(" "));
    assert.match(result.stdout, /\nGlobal options:\n/, command.join(" "));
  }
});

test("help COMMAND is an alias for COMMAND --help", async () => {
  const direct = await runHelp(["ready", "--help"]);
  const alias = await runHelp(["help", "ready"]);

  assert.equal(alias.exitCode, 0);
  assert.equal(alias.stdout, direct.stdout);
  assert.match(alias.stdout, /--include-assigned/);
});

test("global help points to command-specific help", async () => {
  const result = await runHelp(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /shortcut-agent create/);
  assert.match(
    result.stdout,
    /Run `shortcut-agent COMMAND --help` for command-specific help\./,
  );
});

test("unknown help topics return an argument error", async () => {
  const result = await runHelp(["help", "unknown"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /"code":"invalid_arguments"/);
  assert.match(result.stderr, /Unknown help topic: unknown/);
});
