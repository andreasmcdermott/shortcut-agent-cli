import { Buffer } from "node:buffer";
import type { BbPluginApi, PluginCliContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseArgv, integer, option, text } from "../../src/args.js";
import { ShortcutClient } from "../../src/client.js";
import { executeCommand } from "../../src/commands.js";
import { AppError, configError, toErrorPayload } from "../../src/errors.js";

export const CONFIG_FILENAME = ".shortcut-agent.json";

const projectConfigSchema = z
  .object({
    workspace: z.string().min(1),
    epic_id: z.coerce.number().int().positive().optional(),
    team_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    api_url: z.string().url().optional(),
    completion_mode: z.enum(["review", "done"]).optional(),
    states: z
      .object({
        ready: z.coerce.number().int().positive().optional(),
        started: z.coerce.number().int().positive().optional(),
        review: z.coerce.number().int().positive().optional(),
        done: z.coerce.number().int().positive().optional(),
        cancelled: z.coerce.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ConfiguredProject {
  project: { id: string; name: string };
  config: ProjectConfig;
  configPath: string;
}

export interface ShortcutPluginSettings {
  apiToken?: string;
  project?: string;
  enableAgentMutations: boolean;
}

interface SettingsHandle {
  get(): Promise<ShortcutPluginSettings>;
}

const MUTATING_COMMANDS = new Set([
  "create",
  "edit",
  "start",
  "complete",
  "cancel",
  "release",
  "handoff",
  "dep",
]);

function decodeFile(content: string, encoding: "utf8" | "base64") {
  return encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
}

function parseProjectConfig(textValue: string, projectName: string, configPath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch (error) {
    throw new Error(
      `${projectName}/${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = projectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${projectName}/${configPath} is not a usable Shortcut config: ${detail}`);
  }
  return result.data;
}

export async function readProjectConfig(
  bb: BbPluginApi,
  project: { id: string; name: string },
): Promise<ConfiguredProject | null> {
  const read = async (configPath: string) => {
    const file = await bb.sdk.projects.fileContent({
      projectId: project.id,
      path: configPath,
    });
    return parseProjectConfig(
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

export async function resolveConfiguredProject(
  bb: BbPluginApi,
  requestedProjectId: string | null | undefined,
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
    `Multiple bb projects contain ${CONFIG_FILENAME}. Select the default project in Extensions → Plugins → Shortcut Agent.`,
  );
}

function unsupportedOption(parsed: ReturnType<typeof parseArgv>, name: string, message: string) {
  if (option(parsed.options, name) !== undefined) {
    throw new AppError("unsupported_in_bb", message, { exitCode: 2 });
  }
}

function optionInteger(
  parsed: ReturnType<typeof parseArgv>,
  name: string,
  fallback: number | undefined,
) {
  const value = option(parsed.options, name);
  return value === undefined ? fallback : integer(value, `--${name}`);
}

function effectiveConfig(
  configured: ConfiguredProject,
  parsed: ReturnType<typeof parseArgv>,
  token: string,
  threadId?: string,
) {
  const explicitAgent = option(parsed.options, "agent");
  const threadAgent = threadId ? `bb:${threadId}` : undefined;
  const agentId = explicitAgent ?? threadAgent ?? configured.config.agent_id;
  return {
    filename: configured.configPath,
    source: "bb-project",
    exists: true,
    localFilename: undefined,
    apiUrl: process.env.SHORTCUT_API_URL ?? "https://api.app.shortcut.com",
    token,
    workspace: text(parsed.options, "workspace") ?? configured.config.workspace,
    epicId: optionInteger(parsed, "epic", configured.config.epic_id),
    teamId: text(parsed.options, "team") ?? configured.config.team_id,
    agentId,
    agentSource:
      explicitAgent !== undefined
        ? "command"
        : threadAgent
          ? "bb-thread"
          : configured.config.agent_id
            ? "project-config"
            : undefined,
    runId: threadId,
    completionMode: configured.config.completion_mode ?? "review",
    states: {
      ready: optionInteger(parsed, "ready-state", configured.config.states?.ready),
      started: optionInteger(parsed, "started-state", configured.config.states?.started),
      review: optionInteger(parsed, "review-state", configured.config.states?.review),
      done: optionInteger(parsed, "done-state", configured.config.states?.done),
      cancelled: optionInteger(parsed, "cancelled-state", configured.config.states?.cancelled),
    },
    raw: configured.config,
    localRaw: {},
  };
}

async function projectIdFromContext(bb: BbPluginApi, context: PluginCliContext) {
  if (context.projectId) return context.projectId;
  if (!context.threadId) return undefined;
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  return thread.projectId;
}

export function createShortcutService(bb: BbPluginApi, settings: SettingsHandle) {
  async function execute(
    argv: string[],
    context: PluginCliContext = {},
  ): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
    try {
      const parsed = parseArgv(argv);
      if (!parsed.command) {
        throw new AppError("invalid_arguments", "A shortcut-agent command is required", {
          exitCode: 2,
        });
      }
      if (parsed.command === "init") {
        throw new AppError(
          "unsupported_in_bb",
          "`bb shortcut-agent init` is not supported because plugin commands cannot write invoking-machine project files. Run `shortcut-agent init` in the project checkout.",
          { exitCode: 2 },
        );
      }
      unsupportedOption(
        parsed,
        "config",
        "`--config` is not supported by bb integration; scope is resolved from the invoking bb project.",
      );
      unsupportedOption(
        parsed,
        "description-file",
        "`--description-file` is not supported by bb integration; pass `--description` or use a native Shortcut Agent tool.",
      );
      unsupportedOption(
        parsed,
        "api-url",
        "`--api-url` is not supported by bb integration because the server-side secret token may only be sent to the server-configured Shortcut API origin.",
      );

      const current = await settings.get();
      const token = current.apiToken ?? process.env.SHORTCUT_API_TOKEN;
      if (!token) {
        throw configError(
          "Shortcut API token is not configured. Set it in Extensions → Plugins → Shortcut Agent.",
        );
      }
      if (MUTATING_COMMANDS.has(parsed.command) && !current.enableAgentMutations) {
        throw new AppError(
          "agent_mutations_disabled",
          "Shortcut Agent mutations are disabled. Enable agent mutations in Extensions → Plugins → Shortcut Agent.",
          { exitCode: 3 },
        );
      }

      const requestedProjectId = await projectIdFromContext(bb, context);
      const configured = await resolveConfiguredProject(bb, requestedProjectId, current.project);
      const config = effectiveConfig(configured, parsed, token, context.threadId);
      const makeClient = ({ workspace = config.workspace } = {}) =>
        new ShortcutClient({
          token,
          workspace,
          baseUrl: config.apiUrl,
          signal: context.signal,
        });
      const client = makeClient();
      const commandPayload = await executeCommand(parsed, {
        config,
        client,
        makeClient,
        env: {},
      });
      return {
        exitCode: commandPayload.ok === false && parsed.command === "doctor" ? 3 : 0,
        payload: {
          ...commandPayload,
          config_file: commandPayload.config_file ?? configured.configPath,
          config_source: commandPayload.config_source ?? "bb-project",
          project: configured.project,
        },
      };
    } catch (error) {
      const { payload, exitCode } = toErrorPayload(error);
      return { exitCode, payload };
    }
  }

  async function executeTool(
    argv: string[],
    context: { threadId: string; projectId: string; signal: AbortSignal },
  ): Promise<PluginAgentToolResult> {
    const result = await execute(argv, context);
    const textValue = JSON.stringify(result.payload, null, 2);
    if (result.exitCode === 0) return textValue;
    return { content: [{ type: "text", text: textValue }], isError: true };
  }

  return { execute, executeTool };
}
