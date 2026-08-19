import { Buffer } from "node:buffer";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ShortcutClient } from "../../src/client.js";
import {
  classifyStories,
  stateIndex,
  storyState,
  summarizeStory,
} from "../../src/domain.js";
import type { GraphEdge, GraphNode, NodeStatus } from "./graph.js";

const CONFIG_FILENAME = ".shortcut-agent.json";

const configSchema = z
  .object({
    workspace: z.string().min(1),
    epic_id: z.coerce.number().int().positive(),
    api_url: z.string().url().optional(),
  })
  .passthrough();

const nodeStatusSchema = z.enum(["ready", "active", "blocked", "done", "other"]);

const graphNodeSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string().nullable(),
  stateName: z.string(),
  stateType: z.string(),
  status: nodeStatusSchema,
  isActive: z.boolean(),
  blocked: z.boolean(),
  owners: z.array(z.string()),
  position: z.number().nullable(),
  externalBlockedBy: z.array(z.number().int()),
  updatedAt: z.string().nullable(),
});

const graphEdgeSchema = z.object({
  source: z.number().int(),
  target: z.number().int(),
});

const graphResponseSchema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  configPath: z.string(),
  epic: z.object({
    id: z.number().int(),
    name: z.string(),
    url: z.string().nullable(),
  }),
  counts: z.object({
    ready: z.number().int(),
    active: z.number().int(),
    blocked: z.number().int(),
    done: z.number().int(),
    other: z.number().int(),
  }),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  warnings: z.array(z.string()),
  generatedAt: z.string(),
});

export type GraphResponse = z.infer<typeof graphResponseSchema>;

export const rpcContract = defineRpcContract({
  loadGraph: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: graphResponseSchema,
  },
});

interface ProjectConfig {
  workspace: string;
  epic_id: number;
  api_url?: string;
}

interface ConfiguredProject {
  project: { id: string; name: string };
  config: ProjectConfig;
  configPath: string;
}

function decodeFile(content: string, encoding: "utf8" | "base64") {
  return encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
}

function parseConfig(text: string, projectName: string, configPath: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${projectName}/${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${projectName}/${configPath} is not a usable Shortcut config: ${detail}`);
  }
  return result.data;
}

async function readProjectConfig(
  bb: BbPluginApi,
  project: { id: string; name: string },
): Promise<ConfiguredProject | null> {
  const read = async (configPath: string) => {
    const file = await bb.sdk.projects.fileContent({
      projectId: project.id,
      path: configPath,
    });
    return parseConfig(
      decodeFile(file.content, file.contentEncoding),
      project.name,
      configPath,
    );
  };

  try {
    return {
      project,
      config: await read(CONFIG_FILENAME),
      configPath: CONFIG_FILENAME,
    };
  } catch {
    // A bb project normally points at the repository root. Fall back to a
    // bounded recursive lookup so a monorepo can still contain one CLI scope.
  }

  let matches: string[] = [];
  try {
    const result = await bb.sdk.projects.paths({
      projectId: project.id,
      query: CONFIG_FILENAME,
      limit: "50",
      includeFiles: "true",
      includeDirectories: "false",
    });
    matches = result.paths
      .filter(
        (entry) =>
          entry.kind === "file" &&
          (entry.name === CONFIG_FILENAME || entry.path.endsWith(`/${CONFIG_FILENAME}`)),
      )
      .map((entry) => entry.path);
  } catch {
    return null;
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `${project.name} contains multiple ${CONFIG_FILENAME} files. Point bb at the intended repository root.`,
    );
  }
  return { project, config: await read(matches[0]!), configPath: matches[0]! };
}

async function resolveConfiguredProject(
  bb: BbPluginApi,
  requestedProjectId: string | null,
  defaultProjectId: string | undefined,
): Promise<ConfiguredProject> {
  const selectedId = requestedProjectId ?? defaultProjectId;
  if (selectedId) {
    const project = await bb.sdk.projects.get({ projectId: selectedId });
    const configured = await readProjectConfig(bb, project);
    if (!configured) {
      throw new Error(
        `${project.name} does not contain ${CONFIG_FILENAME}. Run shortcut-agent init in that project.`,
      );
    }
    return configured;
  }

  const projects = await bb.sdk.projects.list();
  const configured = (
    await Promise.all(
      projects.map(async (project) => {
        try {
          return await readProjectConfig(bb, project);
        } catch (error) {
          bb.log.warn(
            `could not inspect ${project.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    )
  ).filter((item): item is ConfiguredProject => item !== null);

  if (configured.length === 1) return configured[0]!;
  if (configured.length === 0) {
    throw new Error(
      `No bb project contains ${CONFIG_FILENAME}. Run shortcut-agent init, or select a default project in the plugin settings.`,
    );
  }
  throw new Error(
    `Multiple bb projects contain ${CONFIG_FILENAME}. Select the default project in Extensions → Plugins → Shortcut Epic.`,
  );
}

function statusByStoryId(
  stories: Parameters<typeof classifyStories>[0],
  states: Parameters<typeof classifyStories>[1],
) {
  const groups = classifyStories(stories, states);
  const statuses = new Map<number, NodeStatus>();
  for (const status of ["ready", "active", "blocked", "done", "other"] as const) {
    for (const story of groups[status]) statuses.set(Number(story.id), status);
  }
  return { groups, statuses };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiToken: {
      type: "string",
      label: "Shortcut API token",
      description: "A Shortcut v4 read token. Stored as a bb secret and never sent to the frontend.",
      secret: true,
    },
    project: {
      type: "project",
      label: "Default bb project",
      description:
        "Optional. Used when the panel is not opened from a project, or when several projects have Shortcut config.",
    },
  });

  const initial = await settings.get();
  if (!initial.apiToken && !process.env.SHORTCUT_API_TOKEN) {
    bb.status.needsConfiguration(
      "Set the Shortcut API token in Extensions → Plugins → Shortcut Epic.",
    );
  }

  bb.rpc.register(rpcContract, {
    async loadGraph({ projectId }) {
      const current = await settings.get();
      const token = current.apiToken ?? process.env.SHORTCUT_API_TOKEN;
      if (!token) {
        throw new Error(
          "Shortcut API token is not configured. Set it in Extensions → Plugins → Shortcut Epic.",
        );
      }

      const configured = await resolveConfiguredProject(bb, projectId, current.project);
      const client = new ShortcutClient({
        token,
        workspace: configured.config.workspace,
        baseUrl:
          configured.config.api_url ??
          process.env.SHORTCUT_API_URL ??
          "https://api.app.shortcut.com",
      });

      const [epic, stories, workflowStates] = await Promise.all([
        client.getEpic(configured.config.epic_id),
        client.listEpicStories(configured.config.epic_id),
        client.listWorkflowStates(),
      ]);

      await Promise.all(
        stories.map(async (story) => {
          const nested = story.story_links;
          if (
            nested &&
            !Array.isArray(nested) &&
            nested.list_url &&
            Number(nested.total_items) > (nested.entities?.length ?? 0)
          ) {
            story.story_links = { entities: await client.storyLinks(story) };
          }
        }),
      );

      const index = stateIndex(workflowStates);
      const { groups, statuses } = statusByStoryId(stories, index);
      const storyIds = new Set(stories.map((story) => Number(story.id)));
      const nodes: GraphNode[] = stories.map((story) => {
        const summary = summarizeStory(story, index);
        const state = storyState(story, index);
        const numericPosition = Number(summary.position);
        return {
          id: Number(summary.id),
          title: summary.title ?? `Story ${summary.id}`,
          url: summary.app_url ?? null,
          stateName: summary.state.name ?? summary.state.type ?? "Unknown",
          stateType: summary.state.type ?? "unknown",
          status: statuses.get(Number(summary.id)) ?? "other",
          isActive: state.type === "started",
          blocked: summary.blocked,
          owners: summary.owners.map((owner) => owner.name ?? String(owner.id)),
          position: Number.isFinite(numericPosition) ? numericPosition : null,
          externalBlockedBy: summary.blocked_by.filter((id) => !storyIds.has(id)),
          updatedAt: summary.updated_at ?? null,
        };
      });

      const edgeKeys = new Set<string>();
      const edges: GraphEdge[] = [];
      for (const node of nodes) {
        const summary = summarizeStory(
          stories.find((story) => Number(story.id) === node.id)!,
          index,
        );
        for (const target of summary.blocks) {
          if (!storyIds.has(target)) continue;
          const key = `${node.id}:${target}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          edges.push({ source: node.id, target });
        }
      }

      const warnings: string[] = [];
      if (configured.configPath !== CONFIG_FILENAME) {
        warnings.push(`Using nested config ${configured.configPath}.`);
      }
      const externalCount = nodes.reduce(
        (total, node) => total + node.externalBlockedBy.length,
        0,
      );
      if (externalCount > 0) {
        warnings.push(
          `${externalCount} blocking ${externalCount === 1 ? "edge points" : "edges point"} outside this Epic.`,
        );
      }

      return {
        project: configured.project,
        configPath: configured.configPath,
        epic: {
          id: Number(epic.id),
          name: epic.name ?? `Epic ${epic.id}`,
          url: epic.app_url ?? null,
        },
        counts: {
          ready: groups.ready.length,
          active: groups.active.length,
          blocked: groups.blocked.length,
          done: groups.done.length,
          other: groups.other.length,
        },
        nodes,
        edges,
        warnings,
        generatedAt: new Date().toISOString(),
      };
    },
  });
}
