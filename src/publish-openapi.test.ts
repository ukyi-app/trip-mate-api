import { describe, it, expect } from "vitest";
import { resolveR2Config } from "./publish-openapi.ts";

describe("resolveR2Config", () => {
  const full = {
    R2_ACCESS_KEY_ID: "a",
    R2_SECRET_ACCESS_KEY: "s",
    R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_BUCKET: "trip-mate-contract",
  };
  it("4개 변수 모두 있으면 config 반환(key 기본 openapi.json)", () => {
    expect(resolveR2Config(full)).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "trip-mate-contract",
      key: "openapi.json",
    });
  });
  it("R2_OBJECT_KEY로 키 오버라이드", () => {
    expect(resolveR2Config({ ...full, R2_OBJECT_KEY: "v1/openapi.json" }).key).toBe(
      "v1/openapi.json",
    );
  });
  it("누락 변수를 명시한 에러", () => {
    expect(() => resolveR2Config({ R2_ACCESS_KEY_ID: "a" })).toThrow(/R2_SECRET_ACCESS_KEY/);
    expect(() => resolveR2Config({})).toThrow(/R2_ACCESS_KEY_ID/);
  });
});
