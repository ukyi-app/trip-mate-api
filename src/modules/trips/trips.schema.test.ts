import { describe, it, expect } from "vitest";
import { tripResponseSchema, createTripSchema, updateTripSchema } from "./trips.schema.ts";

const validInput = () => ({
  title: "도쿄",
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  destination_countries: ["JP"],
  timezone: "Asia/Tokyo",
  primary_local_currency: "JPY",
  settlement_currency: "KRW",
  admin_display_name: "여행대장", // §6.1 어드민 표시 이름(생성 입력)
});

describe("trips DTO", () => {
  it("응답은 공개 필드 포함·내부(created_by_user_id) 없음", () => {
    const r = tripResponseSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111", // 유효 UUID(v4·variant)
      ...validInput(),
      settlement_status: "open",
    });
    expect(r.success).toBe(true);
    expect("created_by_user_id" in tripResponseSchema.shape).toBe(false);
  });
  it("create 입력 검증: 정상·title빈값·역순날짜·잘못된날짜·bogus timezone", () => {
    expect(createTripSchema.safeParse(validInput()).success).toBe(true);
    expect(createTripSchema.safeParse({ ...validInput(), title: "" }).success).toBe(false);
    expect(
      createTripSchema.safeParse({
        ...validInput(),
        start_date: "2026-08-09",
        end_date: "2026-08-01",
      }).success,
    ).toBe(false); // 역순
    expect(createTripSchema.safeParse({ ...validInput(), start_date: "2026-99-99" }).success).toBe(
      false,
    ); // 잘못된 달력
    expect(createTripSchema.safeParse({ ...validInput(), timezone: "Mars/Phobos" }).success).toBe(
      false,
    ); // bogus IANA
  });
  it("admin_display_name 필수(§6.1)·1..60자·공백 트림", () => {
    const { admin_display_name: _omit, ...noName } = validInput();
    expect(createTripSchema.safeParse(noName).success).toBe(false); // 누락 → 불가
    expect(createTripSchema.safeParse({ ...validInput(), admin_display_name: "" }).success).toBe(
      false,
    );
    expect(
      createTripSchema.safeParse({ ...validInput(), admin_display_name: "가".repeat(61) }).success,
    ).toBe(false);
    // 공백-only → 트림 후 빈값 → 거부(빈 이름 멤버십 방지)
    expect(createTripSchema.safeParse({ ...validInput(), admin_display_name: "   " }).success).toBe(
      false,
    );
    // 앞뒤 공백 트림 후 저장
    const p = createTripSchema.parse({ ...validInput(), admin_display_name: "  김대장  " });
    expect(p.admin_display_name).toBe("김대장");
  });
  it("update는 통화 immutable(파싱 시 통화 필드 제거)", () => {
    const parsed = updateTripSchema.parse({
      title: "오사카",
      settlement_currency: "USD",
      primary_local_currency: "EUR",
    });
    expect(parsed.title).toBe("오사카");
    expect("settlement_currency" in parsed).toBe(false); // omit돼 파싱 출력에 없음
    expect("primary_local_currency" in parsed).toBe(false);
  });
});
