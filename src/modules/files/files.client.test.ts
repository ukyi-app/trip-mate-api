import { describe, it, expect } from "vitest";
import { filesObjectUrl } from "./files.client.ts";

describe("filesObjectUrl (순수)", () => {
  it("bucket·key로 object URL 구성(?key=)", () => {
    expect(filesObjectUrl("https://files.home.ukyi.app", "trip-mate", "receipts/t/e/u")).toBe(
      "https://files.home.ukyi.app/api/files/trip-mate/object?key=receipts%2Ft%2Fe%2Fu",
    );
  });
  it("base 끝 슬래시 정규화", () => {
    expect(filesObjectUrl("https://x/", "b", "k")).toBe("https://x/api/files/b/object?key=k");
  });
  it("key 특수문자 인코딩(중첩 슬래시·공백)", () => {
    expect(filesObjectUrl("https://x", "b", "a b/c")).toBe(
      "https://x/api/files/b/object?key=a%20b%2Fc",
    );
  });
});
