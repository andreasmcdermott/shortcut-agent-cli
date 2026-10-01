export class AppError extends Error {
  constructor(code, message, { exitCode = 2, details = {}, cause } = {}) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function argumentError(message, details = {}) {
  return new AppError("invalid_arguments", message, { exitCode: 2, details });
}

export function configError(message, details = {}) {
  return new AppError("invalid_configuration", message, { exitCode: 3, details });
}

export function conflictError(code, message, details = {}) {
  return new AppError(code, message, { exitCode: 4, details });
}

export function toErrorPayload(error) {
  const normalized =
    error instanceof AppError
      ? error
      : new AppError("unexpected_error", error?.message ?? String(error), {
          exitCode: 6,
        });

  return {
    payload: {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    },
    exitCode: normalized.exitCode,
  };
}
