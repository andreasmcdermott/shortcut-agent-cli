import { cp, mkdir, readdir, rm } from "node:fs/promises";

// BB loads plugin source within its package boundary. Keep a generated copy of
// the CLI here so path installs and distributable builds use the same code.
const source = new URL("../src/", import.meta.url);
const destination = new URL("../plugins/bb-plugin-shortcut-epic/vendor/shortcut-cli/", import.meta.url);
const files = (await readdir(source)).filter((name) => name.endsWith(".js") || name.endsWith(".d.ts"));
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) {
  if (!files.includes(name)) await rm(new URL(name, destination), { recursive: true });
}
for (const name of files) await cp(new URL(name, source), new URL(name, destination));
