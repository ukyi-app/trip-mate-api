import { z } from "@hono/zod-openapi";

/** 공개 응답 DTO(내부 컬럼 omit). 명시 zod로 OpenAPI 안정. */
export const tripResponseSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    start_date: z.string(), // date (YYYY-MM-DD)
    end_date: z.string(),
    destination_countries: z.array(z.string()),
    timezone: z.string(),
    primary_local_currency: z.string(),
    settlement_currency: z.string(),
    settlement_status: z.enum(["open", "finalized"]),
  })
  .openapi("Trip");

// 실 달력 날짜(2026-99-99 거부, finding #3 pass5). Zod v4 z.iso.date().
const isoDate = z.iso.date();
// IANA timezone 검증(bogus timezone 거부). Intl로 런타임 확인.
const ianaTimezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid IANA timezone" },
);

// 베이스 필드(omit/partial 가능한 ZodObject). refine은 파생 스키마에 적용(ZodEffects는 omit 불가).
const tripFields = z.object({
  title: z.string().min(1).max(100),
  start_date: isoDate,
  end_date: isoDate,
  destination_countries: z.array(z.string().length(2)).min(1),
  timezone: ianaTimezone,
  primary_local_currency: z.string().length(3),
  settlement_currency: z.string().length(3),
});

// start_date ≤ end_date(YYYY-MM-DD 사전식 비교) — DB trip_dates 제약을 422로 선차단(finding #2 pass3).
export const createTripSchema = tripFields
  .refine((d) => d.start_date <= d.end_date, {
    message: "start_date must be <= end_date",
    path: ["end_date"],
  })
  .openapi("CreateTrip");

// 통화는 생성 후 불변(expense 무결성, finding #2 pass2) → UpdateTrip 제외. 둘 다 있으면 날짜 순서 검증.
export const updateTripSchema = tripFields
  .omit({ primary_local_currency: true, settlement_currency: true })
  .partial()
  .refine((d) => !d.start_date || !d.end_date || d.start_date <= d.end_date, {
    message: "start_date must be <= end_date",
    path: ["end_date"],
  })
  .openapi("UpdateTrip");
export type TripResponse = z.infer<typeof tripResponseSchema>;
export type CreateTrip = z.infer<typeof createTripSchema>;
