import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type GraphResponse } from "./server.js";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shortcut Epic plugin backend", () => {
  it("loads project config and returns a validated dependency graph", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/epics/42")) {
        return json({
          entity: {
            id: 42,
            name: "Ship agent workflow",
            app_url: "https://app.shortcut.com/acme/epic/42",
          },
        });
      }
      if (url.pathname.endsWith("/epics/42/stories")) {
        const link = {
          id: 500,
          verb: "blocks",
          subject: { id: 1 },
          object: { id: 2 },
        };
        return json({
          entities: [
            {
              id: 1,
              name: "Foundation",
              app_url: "https://app.shortcut.com/acme/story/1",
              workflow_state: { id: 10 },
              owners: { entities: [{ id: "member-1", name: "Agent owner" }] },
              story_links: { entities: [link] },
              position: 1,
              blocked: false,
              archived: false,
            },
            {
              id: 2,
              name: "Dependent",
              app_url: "https://app.shortcut.com/acme/story/2",
              workflow_state: { id: 11 },
              owners: { entities: [] },
              story_links: { entities: [link] },
              position: 2,
              blocked: true,
              archived: false,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/workflow-states")) {
        return json({
          entities: [
            { id: 10, name: "In Progress", type: "started" },
            { id: 11, name: "Ready", type: "unstarted" },
          ],
        });
      }
      throw new Error(`Unexpected Shortcut request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const project = {
      id: "proj_1",
      kind: "standard" as const,
      name: "Agent project",
      gitRemoteUrl: null,
      createdAt: 1,
      updatedAt: 1,
      sources: [],
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "shortcut-epic",
      settings: { apiToken: "secret" },
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async () => ({
            content: JSON.stringify({ workspace: "acme", epic_id: 42 }),
            contentEncoding: "utf8" as const,
            mimeType: "application/json",
            sizeBytes: 38,
          }),
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc("loadGraph", {
      projectId: "proj_1",
    })) as GraphResponse;

    expect(result.project).toEqual({ id: "proj_1", name: "Agent project" });
    expect(result.epic).toMatchObject({ id: 42, name: "Ship agent workflow" });
    expect(result.edges).toEqual([{ source: 1, target: 2 }]);
    expect(result.nodes).toEqual([
      expect.objectContaining({ id: 1, status: "active", isActive: true }),
      expect.objectContaining({ id: 2, status: "blocked", blocked: true }),
    ]);
    expect(result.counts).toMatchObject({ active: 1, blocked: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await harness.lifecycle.dispose();
  });

  it("reports missing token as a configuration state", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "shortcut-epic",
    });
    await plugin(bb);
    expect(harness.needsConfigurationMessages).toEqual([
      "Set the Shortcut API token in Extensions → Plugins → Shortcut Epic.",
    ]);
    await harness.lifecycle.dispose();
  });
});
