import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, storyIds } from "../src/args.js";

test("parses repeatable relations and boolean global options", () => {
  const parsed = parseArgv([
    "--human",
    "create",
    "--title",
    "Work",
    "--blocked-by",
    "1,2",
    "--blocked-by=3",
  ]);
  assert.equal(parsed.command, "create");
  assert.equal(parsed.options.human, true);
  assert.equal(parsed.options.title, "Work");
  assert.deepEqual(storyIds(parsed.options, "blocked-by"), [1, 2, 3]);
});

test("accepts stdin marker as an option value", () => {
  const parsed = parseArgv(["create", "--description-file", "-"]);
  assert.equal(parsed.options["description-file"], "-");
});
