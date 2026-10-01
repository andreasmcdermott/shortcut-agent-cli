import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("keeps plugin imports inside the package and its public dependencies", () => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
    allow: [
      /^@\//, // Package-local TypeScript alias.
      ...dependencies.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`)),
    ],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
