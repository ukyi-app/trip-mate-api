import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "./cursor.ts";
import { ValidationError } from "../../core/errors.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("expense cursor codec", () => {
  it("encode→decode가 (spent_at ms, id)를 무손실 왕복", () => {
    const spent_at = new Date("2026-08-02T12:30:00.123Z");
    const token = encodeCursor({ spent_at, id: ID });
    const back = decodeCursor(token);
    expect(back.spentAt.getTime()).toBe(spent_at.getTime());
    expect(back.id).toBe(ID);
  });

  it("ms=000도 round-trip 정합(canonical toISOString)", () => {
    const spent_at = new Date("2026-08-02T12:30:00.000Z");
    expect(decodeCursor(encodeCursor({ spent_at, id: ID })).spentAt.getTime()).toBe(
      spent_at.getTime(),
    );
  });

  it("토큰은 URL-safe(base64url: +/= 없음)", () => {
    const token = encodeCursor({ spent_at: new Date("2026-08-02T12:30:00.000Z"), id: ID });
    expect(token).not.toMatch(/[+/=]/);
  });

  it("구조 불일치(구분자 없음) → ValidationError(422)", () => {
    expect(() => decodeCursor(b64url("notadelimitedstring"))).toThrow(ValidationError);
    try {
      decodeCursor(b64url("notadelimitedstring"));
    } catch (e) {
      expect((e as ValidationError).status).toBe(422);
    }
  });

  it("비-UUID id → ValidationError", () => {
    expect(() => decodeCursor(b64url("2026-08-02T12:30:00.000Z|not-a-uuid"))).toThrow(
      ValidationError,
    );
  });

  it("파싱 불가 날짜 → ValidationError", () => {
    expect(() => decodeCursor(b64url(`not-a-date|${ID}`))).toThrow(ValidationError);
  });

  it("비정규 날짜(toISOString 왕복 불일치) → ValidationError", () => {
    expect(() => decodeCursor(b64url(`2026-8-2|${ID}`))).toThrow(ValidationError);
  });

  it("확장연도 ISO(±YYYYYY) → ValidationError (왕복 우회·Postgres 22009/500 차단)", () => {
    for (const iso of ["+275760-09-13T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"])
      expect(() => decodeCursor(b64url(`${iso}|${ID}`))).toThrow(ValidationError);
  });
});
