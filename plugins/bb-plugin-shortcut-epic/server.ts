import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseArgv, flag } from "../../src/args.js";
import {
  ShortcutClient,
  unwrapEntities,
  unwrapEntity,
} from "../../src/client.js";
import { commandHelp, globalHelp } from "../../src/help.js";
import { formatHuman, VERSION } from "../../src/main.js";
import {
  classifyStories,
  stateIndex,
  storyState,
  summarizeStory,
} from "../../src/domain.js";
import type { GraphEdge, GraphNode, NodeStatus } from "./graph.js";
import {
  CONFIG_FILENAME,
  createShortcutService,
  resolveConfiguredProject,
} from "./shortcut-service.js";

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
  configuredEpicId: z.number().int().nullable(),
  mutationsEnabled: z.boolean(),
  generatedAt: z.string(),
});

export type GraphResponse = z.infer<typeof graphResponseSchema>;

const storyDetailSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string(),
    url: z.string().nullable(),
    description: z.string(),
    stateName: z.string(),
    stateType: z.string(),
    storyType: z.string().nullable(),
    blocked: z.boolean(),
    owners: z.array(z.string()),
    updatedAt: z.string().nullable(),
    comments: z.array(
      z
        .object({
          id: z.number().int(),
          author: z.string().nullable(),
          text: z.string(),
          createdAt: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type StoryDetail = z.infer<typeof storyDetailSchema>;

const ownedEpicSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    url: z.string().nullable(),
  })
  .strict();

const ownedEpicsResponseSchema = z
  .object({
    epics: z.array(ownedEpicSchema),
  })
  .strict();

export type OwnedEpic = z.infer<typeof ownedEpicSchema>;

export const rpcContract = defineRpcContract({
  listOwnedEpics: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: ownedEpicsResponseSchema,
  },
  loadGraph: {
    input: z
      .object({
        projectId: z.string().nullable(),
        epicId: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    output: graphResponseSchema,
  },
  loadStory: {
    input: z
      .object({
        storyId: z.number().int().positive(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: storyDetailSchema,
  },
  startWork: {
    input: z
      .object({
        storyId: z.number().int().positive(),
        projectId: z.string().nullable(),
        epicId: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        threadId: z.string().min(1),
        storyId: z.number().int().positive(),
        title: z.string(),
      })
      .strict(),
  },
});

const shownStorySchema = z
  .object({
    story: z
      .object({
        id: z.number().int(),
        title: z.string().nullish(),
        app_url: z.string().nullish(),
        description: z.string().nullish(),
        state: z
          .object({
            name: z.string().nullish(),
            type: z.string().nullish(),
          })
          .nullish(),
        story_type: z.string().nullish(),
        blocked: z.boolean().nullish(),
        owners: z
          .array(
            z.object({
              id: z.union([z.string(), z.number()]),
              name: z.string().nullish(),
            }),
          )
          .nullish(),
        updated_at: z.string().nullish(),
      })
      .passthrough(),
    comments: z
      .array(
        z
          .object({
            id: z.number().int(),
            author: z.unknown().optional(),
            text: z.string().nullish(),
            created_at: z.string().nullish(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

function commentAuthorName(author: unknown) {
  if (typeof author === "string" && author.trim()) return author;
  if (!author || typeof author !== "object") return null;
  const candidate = author as Record<string, unknown>;
  for (const key of ["name", "mention_name", "username", "email"]) {
    if (typeof candidate[key] === "string" && candidate[key].trim()) {
      return candidate[key];
    }
  }
  return null;
}

function cliFailure(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(fallback);
}

function startWorkPrompt({
  storyId,
  title,
  url,
  epicId,
  description,
}: {
  storyId: number;
  title: string;
  url: string | null;
  epicId: number;
  description: string;
}) {
  const body = description.trim() || "_This Story has no description._";
  return [
    `# sc-${storyId}: ${title}`,
    "",
    url ? `Shortcut: ${url}` : null,
    `Epic: ${epicId}`,
    "",
    "## Description",
    "",
    body,
    "",
    "---",
    "",
    "This Story is not claimed yet. Claim it before you change anything, so no",
    "other agent picks it up:",
    "",
    `    bb shortcut-agent start ${storyId} --epic ${epicId}`,
    "",
    "Exit code 4 with `claim_conflict` means another agent claimed it first — stop",
    "and report that instead of implementing it anyway. Exit code 3 with",
    "`agent_mutations_disabled` means the bb plugin setting is off.",
    "",
    "Once you own it, implement it from the description above. When the work is",
    "done and verified:",
    "",
    `    bb shortcut-agent complete ${storyId} --summary '<what changed>' --verification '<how it was checked>'`,
    "",
    "If you cannot proceed, hand the Story back instead of leaving it claimed:",
    "",
    `    bb shortcut-agent release ${storyId} --reason '<why>'`,
  ]
    .filter((line) => line !== null)
    .join("\n");
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
      description: "A Shortcut v4 read/write token. Stored as a bb secret and never sent to agents, the frontend, shell, or environment.",
      secret: true,
    },
    project: {
      type: "project",
      label: "Default bb project",
      description:
        "Optional. Used when the panel, CLI command, or native tool has no project context, or when several projects have Shortcut config.",
    },
    enableAgentMutations: {
      type: "boolean",
      label: "Enable agent mutations",
      description:
        "Allow bb plugin commands and native agent tools to create or change Shortcut Stories. Read-only commands and tools remain available when disabled.",
      default: false,
    },
    openStoriesInPlugin: {
      type: "boolean",
      label: "Open Stories in Shortcut Agent",
      description:
        "When on, clicking a Story card opens its details in the current view. When off, cards open the Shortcut website. The card menu always includes Open in Shortcut.",
      default: true,
    },
  });

  const initial = await settings.get();
  if (!initial.apiToken && !process.env.SHORTCUT_API_TOKEN) {
    bb.status.needsConfiguration(
      "Set the Shortcut API token in Extensions → Plugins → Shortcut Agent.",
    );
  }

  const shortcut = createShortcutService(bb, settings);
  let mutationsEnabled = initial.enableAgentMutations;
  settings.onChange((next) => {
    mutationsEnabled = next.enableAgentMutations;
  });

  bb.cli.register({
    name: "shortcut-agent",
    summary:
      "Read and coordinate Shortcut Agent Stories using the plugin's server-side token and current bb project scope.",
    commands: [
      { name: "context", summary: "Summarize the configured Epic work graph", usage: "bb shortcut-agent context [--epic ID]" },
      { name: "list", summary: "List every Story in the configured Epic", usage: "bb shortcut-agent list [--epic ID]" },
      { name: "ready", summary: "List unblocked, unclaimed Ready Stories", usage: "bb shortcut-agent ready [--epic ID]" },
      { name: "blocked", summary: "List blocked Stories and their blockers", usage: "bb shortcut-agent blocked [--epic ID]" },
      { name: "show", summary: "Show a Story, description, and recent comments", usage: "bb shortcut-agent show STORY [--all-comments]" },
      { name: "create", summary: "Create a Story in the configured Epic (mutations must be enabled)", usage: "bb shortcut-agent create --title TITLE --description TEXT [relations]" },
      { name: "edit", summary: "Edit an existing Story (mutations must be enabled)", usage: "bb shortcut-agent edit STORY [field options]" },
      { name: "start", summary: "Claim and start a Ready Story (mutations must be enabled)", usage: "bb shortcut-agent start STORY [--agent ID]" },
      { name: "complete", summary: "Complete an owned Story (mutations must be enabled)", usage: "bb shortcut-agent complete STORY --summary TEXT" },
      { name: "cancel", summary: "Cancel a Story with a reason (mutations must be enabled)", usage: "bb shortcut-agent cancel STORY --reason TEXT" },
      { name: "release", summary: "Release an owned Story back to Ready (mutations must be enabled)", usage: "bb shortcut-agent release STORY --reason TEXT" },
      { name: "handoff", summary: "Record progress and optionally release a Story (mutations must be enabled)", usage: "bb shortcut-agent handoff STORY --summary TEXT [--release]" },
      { name: "dep", summary: "Add or remove one Story relationship (mutations must be enabled)", usage: "bb shortcut-agent dep add|remove STORY --blocked-by|--blocks|--duplicates|--duplicated-by|--related-to OTHER" },
      { name: "claims", summary: "List in-flight or stale claims", usage: "bb shortcut-agent claims [--stale] [--stale-minutes N]" },
      { name: "config", summary: "Show effective bb project Shortcut Agent configuration", usage: "bb shortcut-agent config" },
      { name: "doctor", summary: "Check Shortcut connectivity and project configuration", usage: "bb shortcut-agent doctor" },
    ],
    async run(argv, context) {
      const parsed = parseArgv(argv);
      if (parsed.command === "help" || flag(parsed.options, "help")) {
        const helpCommand = parsed.command === "help" ? parsed.args[0] : parsed.command;
        const helpSubcommand = parsed.command === "help" ? parsed.args[1] : parsed.subcommand;
        const help = helpCommand ? commandHelp(helpCommand, helpSubcommand) : globalHelp(VERSION);
        if (!help) {
          return { exitCode: 2, stderr: `Unknown help topic: ${[helpCommand, helpSubcommand].filter(Boolean).join(" ")}\n` };
        }
        return {
          exitCode: 0,
          stdout: `${help.replaceAll("shortcut-agent", "bb shortcut-agent")}\n\nbb integration: project scope and API origin are server-controlled; init, --config, --api-url, and --description-file are unsupported.\n`,
        };
      }
      if (parsed.command === "version" || flag(parsed.options, "version")) {
        return { exitCode: 0, stdout: `${VERSION}\n` };
      }
      const result = await shortcut.execute(argv, context);
      const output = flag(parsed.options, "human")
        ? formatHuman(result.payload)
        : JSON.stringify(result.payload, null, flag(parsed.options, "pretty") ? 2 : 0);
      return result.exitCode === 0
        ? { exitCode: 0, stdout: `${output}\n` }
        : { exitCode: result.exitCode, stderr: `${output}\n` };
    },
  });

  const readToolNames = ["shortcut_agent_context", "shortcut_agent_show"];
  const mutationToolNames = [
    "shortcut_agent_create",
    "shortcut_agent_edit",
    "shortcut_agent_add_dependency",
    "shortcut_agent_start",
    "shortcut_agent_complete",
    "shortcut_agent_release",
  ];
  bb.agents.configure(() => ({
    tools: mutationsEnabled ? [...readToolNames, ...mutationToolNames] : readToolNames,
    skills: mutationsEnabled ? ["agent-next-ready"] : [],
  }));

  bb.agents.registerTool({
    name: "shortcut_agent_context",
    description: "Summarize ready, active, blocked, and recently completed Stories in the Shortcut Epic configured for the current bb project.",
    parameters: z.object({ epicId: z.number().int().positive().optional() }).strict(),
    presentation: { label: { pending: "Loading Shortcut work graph", completed: "Loaded Shortcut work graph" } },
    execute({ epicId }, context) {
      return shortcut.executeTool(
        ["context", ...(epicId ? ["--epic", String(epicId)] : [])],
        context,
      );
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_show",
    description: "Read one Shortcut Story, including its full description and recent human or agent-event comments. Always use this before starting work on a Story.",
    instructions: "Call shortcut_agent_show before shortcut_agent_start so the Story description and handoff context are known.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        allComments: z.boolean().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Reading Shortcut Story", completed: "Read Shortcut Story" } },
    execute({ storyId, allComments }, context) {
      return shortcut.executeTool(
        ["show", String(storyId), ...(allComments ? ["--all-comments"] : [])],
        context,
      );
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_create",
    description: "Create an unowned Shortcut Story in the configured Epic's Ready state, with optional dependency links. Requires Enable agent mutations.",
    parameters: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(["bug", "chore", "feature"]).optional(),
        estimate: z.number().int().positive().optional(),
        blockedBy: z.array(z.number().int().positive()).optional(),
        blocks: z.array(z.number().int().positive()).optional(),
        duplicates: z.array(z.number().int().positive()).optional(),
        duplicatedBy: z.array(z.number().int().positive()).optional(),
        relatedTo: z.array(z.number().int().positive()).optional(),
        epicId: z.number().int().positive().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Creating Shortcut Story", completed: "Created Shortcut Story" } },
    execute(input, context) {
      const argv = ["create", "--title", input.title, "--description", input.description];
      if (input.type) argv.push("--type", input.type);
      if (input.estimate) argv.push("--estimate", String(input.estimate));
      if (input.epicId) argv.push("--epic", String(input.epicId));
      for (const id of input.blockedBy ?? []) argv.push("--blocked-by", String(id));
      for (const id of input.blocks ?? []) argv.push("--blocks", String(id));
      for (const id of input.duplicates ?? []) argv.push("--duplicates", String(id));
      for (const id of input.duplicatedBy ?? []) argv.push("--duplicated-by", String(id));
      for (const id of input.relatedTo ?? []) argv.push("--related-to", String(id));
      return shortcut.executeTool(argv, context);
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_edit",
    description: "Edit fields on an existing Shortcut Story. Lifecycle state changes should use the dedicated start, complete, or release tools. Requires Enable agent mutations.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        type: z.enum(["bug", "chore", "feature"]).optional(),
        estimate: z.number().int().positive().optional(),
        clearEstimate: z.boolean().optional(),
        moveToEpicId: z.number().int().positive().optional(),
        teamId: z.string().min(1).optional(),
        clearTeam: z.boolean().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Editing Shortcut Story", completed: "Edited Shortcut Story" } },
    execute(input, context) {
      const argv = ["edit", String(input.storyId)];
      if (input.title !== undefined) argv.push("--title", input.title);
      if (input.description !== undefined) argv.push("--description", input.description);
      if (input.type) argv.push("--type", input.type);
      if (input.estimate) argv.push("--estimate", String(input.estimate));
      if (input.clearEstimate) argv.push("--clear-estimate");
      if (input.moveToEpicId) argv.push("--move-to-epic", String(input.moveToEpicId));
      if (input.teamId) argv.push("--set-team", input.teamId);
      if (input.clearTeam) argv.push("--clear-team");
      return shortcut.executeTool(argv, context);
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_add_dependency",
    description: "Add one blocks, blocked-by, duplicates, duplicated-by, or related-to relationship between Shortcut Stories, preserving the CLI's cycle and cross-Epic safety checks. Requires Enable agent mutations.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        relation: z.enum(["blocked-by", "blocks", "duplicates", "duplicated-by", "related-to"]),
        otherStoryId: z.number().int().positive(),
        allowCrossEpic: z.boolean().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Adding Shortcut dependency", completed: "Added Shortcut dependency" } },
    execute(input, context) {
      return shortcut.executeTool(
        [
          "dep",
          "add",
          String(input.storyId),
          `--${input.relation}`,
          String(input.otherStoryId),
          ...(input.allowCrossEpic ? ["--allow-cross-epic"] : []),
        ],
        context,
      );
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_start",
    description: "Claim an unowned, unblocked Ready Story and move it to Started. The current bb thread is used as agent identity unless agentId is supplied. Requires Enable agent mutations.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        agentId: z.string().min(1).optional(),
        epicId: z.number().int().positive().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Claiming Shortcut Story", completed: "Claimed Shortcut Story" } },
    execute(input, context) {
      return shortcut.executeTool(
        [
          "start",
          String(input.storyId),
          ...(input.agentId ? ["--agent", input.agentId] : []),
          ...(input.epicId ? ["--epic", String(input.epicId)] : []),
        ],
        context,
      );
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_complete",
    description: "Record completion evidence and move an owned Started Story to Review (or Done when configured). Requires Enable agent mutations.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        summary: z.string().min(1),
        verification: z.string().min(1).optional(),
        evidence: z.string().min(1).optional(),
        changed: z.string().min(1).optional(),
        remaining: z.string().min(1).optional(),
        agentId: z.string().min(1).optional(),
        epicId: z.number().int().positive().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Completing Shortcut Story", completed: "Completed Shortcut Story" } },
    execute(input, context) {
      const argv = ["complete", String(input.storyId), "--summary", input.summary];
      for (const [name, value] of [
        ["verification", input.verification],
        ["evidence", input.evidence],
        ["changed", input.changed],
        ["remaining", input.remaining],
        ["agent", input.agentId],
      ] as const) {
        if (value) argv.push(`--${name}`, value);
      }
      if (input.epicId) argv.push("--epic", String(input.epicId));
      return shortcut.executeTool(argv, context);
    },
  });

  bb.agents.registerTool({
    name: "shortcut_agent_release",
    description: "Record a reason, clear Story owners, and return a Story to Ready. Use force only to recover a confirmed stale claim. Requires Enable agent mutations.",
    parameters: z
      .object({
        storyId: z.number().int().positive(),
        reason: z.string().min(1),
        force: z.boolean().optional(),
        agentId: z.string().min(1).optional(),
        epicId: z.number().int().positive().optional(),
      })
      .strict(),
    presentation: { label: { pending: "Releasing Shortcut Story", completed: "Released Shortcut Story" } },
    execute(input, context) {
      return shortcut.executeTool(
        [
          "release",
          String(input.storyId),
          "--reason",
          input.reason,
          ...(input.force ? ["--force"] : []),
          ...(input.agentId ? ["--agent", input.agentId] : []),
          ...(input.epicId ? ["--epic", String(input.epicId)] : []),
        ],
        context,
      );
    },
  });

  bb.rpc.register(rpcContract, {
    async listOwnedEpics({ projectId }) {
      const current = await settings.get();
      const token = current.apiToken ?? process.env.SHORTCUT_API_TOKEN;
      if (!token) {
        throw new Error(
          "Shortcut API token is not configured. Set it in Extensions → Plugins → Shortcut Agent.",
        );
      }

      const configured = await resolveConfiguredProject(bb, projectId, current.project);
      const client = new ShortcutClient({
        token,
        workspace: configured.config.workspace,
        baseUrl:
          process.env.SHORTCUT_API_URL ??
          "https://api.app.shortcut.com",
      });
      const [identityPayload, epicsPayload] = await Promise.all([
        client.request("GET", "/api/v3/member"),
        client.request("GET", "/api/v3/epics", {
          query: { includes_description: false },
        }),
      ]);
      const identity = unwrapEntity(identityPayload) as { id?: unknown };
      const epics = unwrapEntities(epicsPayload) as Array<{
        id: number | string;
        name?: string;
        app_url?: string;
        archived?: boolean;
        completed?: boolean;
        owner_ids?: Array<number | string>;
        owners?: { entities?: Array<{ id: number | string }> };
      }>;
      const memberId = String(identity?.id ?? "");
      if (!memberId) {
        throw new Error("Shortcut did not identify the current member.");
      }

      const owned = epics
        .filter((epic) => {
          const ownerIds = epic.owner_ids ?? [];
          const owners = epic.owners?.entities ?? [];
          return (
            !epic.archived &&
            !epic.completed &&
            (ownerIds.some((ownerId) => String(ownerId) === memberId) ||
              owners.some((owner) => String(owner.id) === memberId))
          );
        })
        .map((epic) => ({
          id: Number(epic.id),
          name: epic.name ?? `Epic ${epic.id}`,
          url: epic.app_url ?? null,
        }))
        .filter((epic) => Number.isSafeInteger(epic.id) && epic.id > 0)
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        );

      return { epics: owned };
    },
    async loadGraph({ projectId, epicId }) {
      const current = await settings.get();
      const token = current.apiToken ?? process.env.SHORTCUT_API_TOKEN;
      if (!token) {
        throw new Error(
          "Shortcut API token is not configured. Set it in Extensions → Plugins → Shortcut Agent.",
        );
      }

      const configured = await resolveConfiguredProject(bb, projectId, current.project);
      const selectedEpicId = epicId ?? configured.config.epic_id;
      if (!selectedEpicId) {
        throw new Error(
          "No Epic is selected. Enter an Epic ID in the panel or add epic_id to .shortcut-agent.json.",
        );
      }
      const client = new ShortcutClient({
        token,
        workspace: configured.config.workspace,
        baseUrl:
          process.env.SHORTCUT_API_URL ??
          "https://api.app.shortcut.com",
      });

      const [epic, stories, workflowStates] = await Promise.all([
        client.getEpic(selectedEpicId),
        client.listEpicStories(selectedEpicId),
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
        configuredEpicId: configured.config.epic_id ?? null,
        mutationsEnabled: current.enableAgentMutations,
        generatedAt: new Date().toISOString(),
      };
    },

    async loadStory({ storyId, projectId }) {
      const detail = await shortcut.execute(["show", String(storyId)], {
        projectId: projectId ?? undefined,
      });
      if (detail.exitCode !== 0) {
        throw cliFailure(detail.payload, `Could not read Story ${storyId}.`);
      }
      const shown = shownStorySchema.safeParse(detail.payload);
      if (!shown.success) {
        throw new Error(`Shortcut returned an invalid response for Story ${storyId}.`);
      }
      const story = shown.data.story;
      return {
        id: story.id,
        title: story.title ?? `Story ${story.id}`,
        url: story.app_url ?? null,
        description: story.description ?? "",
        stateName: story.state?.name ?? story.state?.type ?? "Unknown",
        stateType: story.state?.type ?? "unknown",
        storyType: story.story_type ?? null,
        blocked: story.blocked ?? false,
        owners: (story.owners ?? []).map((owner) => owner.name ?? String(owner.id)),
        updatedAt: story.updated_at ?? null,
        comments: (shown.data.comments ?? []).map((comment) => ({
          id: comment.id,
          author: commentAuthorName(comment.author),
          text: comment.text ?? "",
          createdAt: comment.created_at ?? null,
        })),
      };
    },

    async startWork({ storyId, projectId, epicId }) {
      const current = await settings.get();
      const token = current.apiToken ?? process.env.SHORTCUT_API_TOKEN;
      if (!token) {
        throw new Error(
          "Shortcut API token is not configured. Set it in Extensions → Plugins → Shortcut Agent.",
        );
      }
      if (!current.enableAgentMutations) {
        throw new Error(
          "The agent has to claim the Story before working it. Enable agent mutations in Extensions → Plugins → Shortcut Agent first.",
        );
      }

      const configured = await resolveConfiguredProject(bb, projectId, current.project);
      const selectedEpicId = epicId ?? configured.config.epic_id;
      if (!selectedEpicId) {
        throw new Error(
          "No Epic is selected. Enter an Epic ID in the panel or add epic_id to .shortcut-agent.json.",
        );
      }

      const detail = await shortcut.execute(["show", String(storyId)], {
        projectId: configured.project.id,
      });
      if (detail.exitCode !== 0) {
        throw cliFailure(detail.payload, `Could not read Story ${storyId}.`);
      }
      const shown = shownStorySchema.safeParse(detail.payload);
      const story = shown.success ? shown.data.story : null;
      const title = story?.title ?? `Story ${storyId}`;

      const thread = await bb.sdk.threads.spawn({
        projectId: configured.project.id,
        environment: { type: "project-default" },
        title: `sc-${storyId}: ${title}`,
        prompt: startWorkPrompt({
          storyId,
          title,
          url: story?.app_url ?? null,
          epicId: Number(selectedEpicId),
          description: story?.description ?? "",
        }),
      });

      return { threadId: thread.id, storyId, title };
    },
  });
}
