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
export class UnsupportedMediaTypeError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("UnsupportedMediaTypeError", 415, message, meta);
  }
}
export class FxUnresolvedError extends AppError {
  // resolveFx가 needsManual(모든 fallback 실패) → 클라가 manualRate 첨부 재요청. 422.
  constructor(message?: string, meta?: unknown) {
    super("FxUnresolvedError", 422, message, meta);
  }
}
export class SettlementInvariantError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("SettlementInvariantError", 422, message, meta);
  }
}
export class TooManyRequestsError extends AppError {
  // 쿼터 초과 → 429. meta.retryAfterSeconds가 필터에서 Retry-After 헤더로.
  constructor(message?: string, meta?: unknown) {
    super("TooManyRequestsError", 429, message, meta);
  }
}
export class UpstreamError extends AppError {
  // 외부 의존(LLM 등) 호출 실패·비정형 응답 → 502. 상세는 meta로(원문 비노출).
  constructor(message?: string, meta?: unknown) {
    super("UpstreamError", 502, message, meta);
  }
}
export class UnavailableError extends AppError {
  // 기능 미설정(graceful off) — 라우트는 등록하되 503으로 명시적 신호(스펙-런타임 불일치 방지).
  constructor(message?: string, meta?: unknown) {
    super("UnavailableError", 503, message, meta);
  }
}

/** RFC 9457 problem+json 매핑. AppError는 code/status, 그 외 500.
 *  app은 plain Hono(테스트)·OpenAPIHono(main) 모두 수용(Hono↔OpenAPIHono의 .fetch 변성 회피). */
// oxlint-disable-next-line typescript/no-explicit-any
export function registerErrorFilter(app: Hono<any, any, any>): void {
  app.onError((err, c) => {
    const problemJson: Record<string, string> = {
      "content-type": "application/problem+json", // RFC 9457 미디어타입(finding #3 pass2)
    };
    if (err instanceof AppError) {
      // meta.retryAfterSeconds → Retry-After 헤더(백프레셔 — busy 503 등이 클라 백오프 유도)
      const retry = (err.meta as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (typeof retry === "number" && retry > 0) problemJson["Retry-After"] = String(retry);
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
