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

describe("Shortcut Agent plugin backend", () => {
  it("loads project config and returns a validated dependency graph", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/epics/84")) {
        return json({
          entity: {
            id: 84,
            name: "Second agent workflow",
            app_url: "https://app.shortcut.com/acme/epic/84",
          },
        });
      }
      if (url.pathname.endsWith("/epics/84/stories")) {
        return json({ entities: [] });
      }
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
    expect(result.configuredEpicId).toBe(42);

    const override = (await harness.behavior.callRpc("loadGraph", {
      projectId: "proj_1",
      epicId: 84,
    })) as GraphResponse;
    expect(override.epic).toMatchObject({ id: 84, name: "Second agent workflow" });
    expect(override.configuredEpicId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    await harness.lifecycle.dispose();
  });

  it("reports missing token as a configuration state", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "shortcut-epic",
    });
    await plugin(bb);
    expect(harness.needsConfigurationMessages).toEqual([
      "Set the Shortcut API token in Extensions → Plugins → Shortcut Agent.",
    ]);
    await harness.lifecycle.dispose();
  });

  it("exposes read tools while mutations are disabled and gates CLI writes", async () => {
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
      agentSkillIds: ["agent-next-ready"],
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async () => ({
            content: JSON.stringify({
              workspace: "acme",
              epic_id: 42,
              states: { ready: 11, started: 10, done: 12 },
            }),
            contentEncoding: "utf8" as const,
            mimeType: "application/json",
            sizeBytes: 100,
          }),
        },
      },
    });
    await plugin(bb);

    const context = {
      thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "proj_1", kind: "standard" as const, name: "Agent project", gitRemoteUrl: null },
      environment: {
        id: "env-1",
        name: null,
        path: "/repo",
        workspaceProvisionType: "unmanaged" as const,
        branchName: "main",
      },
      host: { id: "host-1", name: "Local" },
      provider: {
        id: "codex",
        model: "test",
        capabilities: {
          supportsServiceTier: false,
          supportsNativeUserQuestion: false,
          fork: "none" as const,
          supportsManualCompaction: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
          supportsWorkflows: false,
          permissionModes: ["full" as const],
          reasoningLevels: ["medium"],
        },
      },
      sideChat: false,
      origin: { kind: null, pluginId: null },
    };
    const readOnly = await harness.behavior.resolveAgentConfiguration(context);
    expect(readOnly.tools.map((tool) => tool.name)).toEqual([
      "shortcut_agent_context",
      "shortcut_agent_show",
    ]);
    expect(readOnly.skills).toEqual([]);

    const blocked = await harness.behavior.runCli(
      ["create", "--title", "Nope", "--description", "Disabled"],
      { projectId: "proj_1", threadId: "thread-1" },
    );
    expect(blocked.exitCode).toBe(3);
    expect(JSON.parse(blocked.stderr)).toMatchObject({
      error: { code: "agent_mutations_disabled" },
    });

    const redirected = await harness.behavior.runCli(
      ["show", "7", "--api-url", "https://example.test"],
      { projectId: "proj_1", threadId: "thread-1" },
    );
    expect(redirected.exitCode).toBe(2);
    expect(JSON.parse(redirected.stderr)).toMatchObject({
      error: { code: "unsupported_in_bb" },
    });

    await harness.behavior.setSettings({ enableAgentMutations: true });
    const writable = await harness.behavior.resolveAgentConfiguration(context);
    expect(writable.tools.map((tool) => tool.name)).toContain("shortcut_agent_start");
    expect(writable.skills).toEqual(["agent-next-ready"]);
    await harness.lifecycle.dispose();
  });

  it("runs lifecycle tools with the secret token and bb thread identity server-side", async () => {
    let storyReads = 0;
    let claimText = "";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      if (url.pathname.endsWith("/stories/7") && init?.method === "GET") {
        storyReads += 1;
        return json({
          entity: {
            id: 7,
            name: "Claim me",
            epic: { id: 42 },
            workflow_state: { id: storyReads === 1 ? 11 : 10 },
            owners: {
              entities: storyReads === 1 ? [] : [{ id: "member-1", name: "Agent owner" }],
            },
            story_links: { entities: [] },
            blocked: false,
            archived: false,
          },
        });
      }
      if (url.pathname.endsWith("/whoami")) {
        return json({ entity: { member: { id: "member-1" } } });
      }
      if (url.pathname.endsWith("/workflow-states")) {
        return json({
          entities: [
            { id: 11, name: "Ready", type: "unstarted" },
            { id: 10, name: "In Progress", type: "started" },
            { id: 12, name: "Done", type: "done" },
          ],
        });
      }
      if (url.pathname.endsWith("/stories/7") && init?.method === "PATCH") {
        return json({ entity: { id: 7 } });
      }
      if (url.pathname.endsWith("/stories/7/comments") && init?.method === "POST") {
        claimText = String(JSON.parse(String(init.body)).text);
        return json({ entity: { id: 99 } });
      }
      throw new Error(`Unexpected Shortcut request: ${init?.method} ${url}`);
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
      settings: { apiToken: "secret-token", enableAgentMutations: true },
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async () => ({
            content: JSON.stringify({
              workspace: "acme",
              epic_id: 42,
              states: { ready: 11, started: 10, done: 12 },
            }),
            contentEncoding: "utf8" as const,
            mimeType: "application/json",
            sizeBytes: 100,
          }),
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool(
      "shortcut_agent_start",
      { storyId: 7 },
      { projectId: "proj_1", threadId: "thread-123" },
    );
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toMatchObject({
      ok: true,
      command: "start",
      story: { id: 7, state: { id: 10 } },
    });
    expect(claimText).toContain('"agent_id":"bb:thread-123"');
    expect(claimText).toContain('"run_id":"thread-123"');
    expect(String(result)).not.toContain("secret-token");
    await harness.lifecycle.dispose();
  });

  it("spawns a bb thread that claims the Story itself when the panel starts work", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stories/7") && init?.method === "GET") {
        return json({
          entity: {
            id: 7,
            name: "Claim me",
            description: "Implement the parser.",
            app_url: "https://app.shortcut.com/acme/story/7",
            epic: { id: 42 },
            workflow_state: { id: 11 },
            owners: { entities: [] },
            story_links: { entities: [] },
            blocked: false,
            archived: false,
          },
        });
      }
      if (url.pathname.endsWith("/stories/7/comments") && init?.method === "GET") {
        return json({ entities: [] });
      }
      if (url.pathname.endsWith("/workflow-states")) {
        return json({
          entities: [
            { id: 11, name: "Ready", type: "unstarted" },
            { id: 10, name: "In Progress", type: "started" },
            { id: 12, name: "Done", type: "done" },
          ],
        });
      }
      throw new Error(`Unexpected Shortcut request: ${init?.method} ${url}`);
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
    const spawned: {
      projectId: string;
      title?: string;
      prompt?: string;
      environment?: { type: string };
    }[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "shortcut-epic",
      settings: { apiToken: "secret-token", enableAgentMutations: true },
      sdk: {
        projects: {
          get: async () => project,
          fileContent: async () => ({
            content: JSON.stringify({
              workspace: "acme",
              epic_id: 42,
              states: { ready: 11, started: 10, done: 12 },
            }),
            contentEncoding: "utf8" as const,
            mimeType: "application/json",
            sizeBytes: 100,
          }),
        },
        threads: {
          spawn: async (args) => {
            spawned.push(args as (typeof spawned)[number]);
            return { id: "thread_new" };
          },
        },
      },
    });
    await plugin(bb);

    const started = await harness.behavior.callRpc("startWork", {
      storyId: 7,
      projectId: "proj_1",
      epicId: 42,
    });
    expect(started).toMatchObject({ threadId: "thread_new", storyId: 7, title: "Claim me" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1",
      environment: { type: "project-default" },
      title: "sc-7: Claim me",
    });
    const prompt = String(spawned[0]!.prompt);
    expect(prompt).toContain("Implement the parser.");
    expect(prompt).toContain("bb shortcut-agent start 7 --epic 42");
    expect(prompt).toContain("bb shortcut-agent complete 7");
    expect(prompt).not.toContain("secret-token");
    expect(
      fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
    ).toBe(true);

    await harness.lifecycle.dispose();
  });

  it("refuses to open a work thread while mutations are disabled", async () => {
    const project = {
      id: "proj_1",
      kind: "standard" as const,
      name: "Agent project",
      gitRemoteUrl: null,
      createdAt: 1,
      updatedAt: 1,
      sources: [],
    };
    const spawned: {
      projectId: string;
      title?: string;
      prompt?: string;
      environment?: { type: string };
    }[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "shortcut-epic",
      settings: { apiToken: "secret-token" },
      sdk: {
        projects: { get: async () => project },
        threads: {
          spawn: async (args) => {
            spawned.push(args as (typeof spawned)[number]);
            return { id: "thread_new" };
          },
        },
      },
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("startWork", {
        storyId: 7,
        projectId: "proj_1",
        epicId: 42,
      }),
    ).rejects.toThrow(/Enable agent mutations/);
    expect(spawned).toEqual([]);

    await harness.lifecycle.dispose();
  });
});
