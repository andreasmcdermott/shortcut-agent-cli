export class AppError extends Error {
  code: string;
  exitCode: number;
  details: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    options?: {
      exitCode?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  );
}

export function argumentError(message: string, details?: Record<string, unknown>): AppError;
export function configError(message: string, details?: Record<string, unknown>): AppError;
export function conflictError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError;
export function toErrorPayload(error: unknown): {
  payload: {
    ok: false;
    error: {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
  };
  exitCode: number;
};
