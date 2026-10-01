import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);
const vendor = new URL("../plugins/bb-plugin-shortcut-epic/vendor/shortcut-cli/", import.meta.url);

test("the plugin ships the current CLI source and declarations", async () => {
  const files = (await readdir(source)).filter((name) => name.endsWith(".js") || name.endsWith(".d.ts")).sort();
  assert.deepEqual((await readdir(vendor)).sort(), files);
  for (const name of files) {
    assert.equal(
      await readFile(new URL(name, vendor), "utf8"),
      await readFile(new URL(name, source), "utf8"),
      `${name} is stale; run npm run sync:plugin`,
    );
  }
});
