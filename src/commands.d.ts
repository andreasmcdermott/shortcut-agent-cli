import type { ParsedArgv } from "./args.js";
import type { ShortcutClient } from "./client.js";

export interface CommandContext {
  config: Record<string, any>;
  client: ShortcutClient;
  makeClient(options?: { workspace?: string }): ShortcutClient;
  cwd?: string;
  stdin?: NodeJS.ReadableStream;
  env?: Record<string, string | undefined>;
}

export function executeCommand(
  parsed: ParsedArgv,
  context: CommandContext,
): Promise<Record<string, any>>;
