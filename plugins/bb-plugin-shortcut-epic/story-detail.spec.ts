import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type StoryDetail } from "./server.js";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shortcut Agent Story details", () => {
  it("loads and normalizes one Story for the plugin modal", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stories/7/comments")) {
        return json({
          entities: [
            {
              id: 70,
              author: { name: "Agent owner" },
              text: "Ready for review.",
              created_at: "2026-08-19T16:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/stories/7")) {
        return json({
          entity: {
            id: 7,
            name: "Show this Story",
            description: "Full Story description.",
            app_url: "https://app.shortcut.com/acme/story/7",
            story_type: "feature",
            workflow_state: { id: 11 },
            owners: { entities: [{ id: "member-1", name: "Agent owner" }] },
            story_links: { entities: [] },
            blocked: false,
            archived: false,
            updated_at: "2026-08-19T17:00:00.000Z",
          },
        });
      }
      if (url.pathname.endsWith("/workflow-states")) {
        return json({ entities: [{ id: 11, name: "Ready", type: "unstarted" }] });
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

    const detail = (await harness.behavior.callRpc("loadStory", {
      storyId: 7,
      projectId: "proj_1",
    })) as StoryDetail;

    expect(detail).toEqual({
      id: 7,
      title: "Show this Story",
      url: "https://app.shortcut.com/acme/story/7",
      description: "Full Story description.",
      stateName: "Ready",
      stateType: "unstarted",
      storyType: "feature",
      blocked: false,
      owners: ["Agent owner"],
      updatedAt: "2026-08-19T17:00:00.000Z",
      comments: [
        {
          id: 70,
          author: "Agent owner",
          text: "Ready for review.",
          createdAt: "2026-08-19T16:00:00.000Z",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await harness.lifecycle.dispose();
  });
});
