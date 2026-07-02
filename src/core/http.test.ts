import { describe, it, expect } from "vitest";
import { createRoute, z } from "@hono/zod-openapi";
import { problemSchema, errorResponses, idempotencyKeyHeader } from "./http.ts";
import { createApp } from "./openapi.ts";

describe("problem+json 계약", () => {
  it("problemSchema는 type·title·status·code 필수", () => {
    const ok = problemSchema.safeParse({
      type: "about:blank",
      title: "ForbiddenError",
      status: 403,
      code: "ForbiddenError",
    });
    expect(ok.success).toBe(true);
    expect(problemSchema.safeParse({ title: "x" }).success).toBe(false);
  });
  it("errorResponses는 지정 status들의 problem 스키마 응답 생성", () => {
    const r = errorResponses(403, 404);
    expect(Object.keys(r)).toEqual(["403", "404"]);
    expect(r[403]!.content["application/problem+json"].schema).toBe(problemSchema);
  });
  it("zod 검증 실패 → 422 problem+json(code=ValidationError, content-type)", async () => {
    const app = createApp();
    app.openapi(
      createRoute({
        method: "post",
        path: "/x",
        request: {
          body: {
            content: { "application/json": { schema: z.object({ n: z.number() }) } },
            required: true,
          },
        },
        responses: { 200: { description: "ok" } },
      }),
      (c) => c.json({}, 200),
    );
    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: "bad" }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    expect(((await res.json()) as { code: string }).code).toBe("ValidationError");
  });
});

describe("idempotencyKeyHeader 헤더 파라미터", () => {
  it("헤더 없음(no-op 보존)·정상 키·경계값 통과, 200자 초과 거부", () => {
    // required 아님 → 헤더 미제공 요청도 유효(기존 no-op 보존)
    expect(idempotencyKeyHeader.safeParse({}).success).toBe(true);
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "k-1" }).success).toBe(true);
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "a".repeat(200) }).success).toBe(
      true,
    );
    expect(idempotencyKeyHeader.safeParse({ "Idempotency-Key": "a".repeat(201) }).success).toBe(
      false,
    );
  });
});
