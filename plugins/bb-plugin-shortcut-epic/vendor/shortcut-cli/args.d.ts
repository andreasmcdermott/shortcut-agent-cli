export type ParsedOptionValue = string | boolean | Array<string | boolean>;
export interface ParsedArgv {
  command?: string;
  subcommand?: string;
  args: string[];
  options: Record<string, ParsedOptionValue>;
}

export function parseArgv(argv: string[]): ParsedArgv;
export function option(
  options: ParsedArgv["options"],
  key: string,
  fallback?: string | boolean,
): string | boolean | undefined;
export function flag(
  options: ParsedArgv["options"],
  key: string,
  fallback?: boolean,
): boolean;
export function text(
  options: ParsedArgv["options"],
  key: string,
  fallback?: string,
): string | undefined;
export function values(options: ParsedArgv["options"], key: string): string[];
export function integer(
  value: unknown,
  label: string,
  options?: { required?: boolean },
): number | undefined;
export function storyIds(options: ParsedArgv["options"], key: string): number[];
export function requirePositional(parsed: ParsedArgv, index: number, label: string): string;
