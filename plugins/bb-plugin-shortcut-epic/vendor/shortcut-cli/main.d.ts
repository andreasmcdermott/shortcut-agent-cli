export const VERSION: string;
export function formatHuman(payload: Record<string, any>): string;
export function run(
  argv: string[],
  context?: Record<string, unknown>,
): Promise<number>;
export function main(argv: string[]): Promise<void>;
