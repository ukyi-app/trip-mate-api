import type { Hono } from "hono";

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly meta?: unknown,
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("NotFoundError", 404, message, meta);
  }
}
export class ForbiddenError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ForbiddenError", 403, message, meta);
  }
}
export class ConflictError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ConflictError", 409, message, meta);
  }
}
export class ValidationError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ValidationError", 422, message, meta);
  }
}
export class SettlementInvariantError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("SettlementInvariantError", 422, message, meta);
  }
}

/** RFC 9457 problem+json 매핑. AppError는 code/status, 그 외 500.
 *  app은 plain Hono(테스트)·OpenAPIHono(main) 모두 수용(Hono↔OpenAPIHono의 .fetch 변성 회피). */
// oxlint-disable-next-line typescript/no-explicit-any
export function registerErrorFilter(app: Hono<any, any, any>): void {
  app.onError((err, c) => {
    const problemJson = { "content-type": "application/problem+json" }; // RFC 9457 미디어타입(finding #3 pass2)
    if (err instanceof AppError) {
      return c.json(
        {
          type: "about:blank",
          title: err.code,
          status: err.status,
          code: err.code,
          detail: err.message,
          meta: err.meta,
        },
        err.status as never,
        problemJson,
      );
    }
    return c.json(
      { type: "about:blank", title: "InternalError", status: 500, code: "InternalError" },
      500,
      problemJson,
    );
  });
}
