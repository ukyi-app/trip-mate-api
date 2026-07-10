import { z } from "@hono/zod-openapi";
import { displayName } from "../../core/schema.ts";

/** DB row 형태(trips 컬럼만) — repo 반환 타입(D-D). user_id 등 내부 컬럼은 select에 없음. DTO 아님(.openapi 미부여). */
export const tripRowShape = z.object({
  id: z.string().uuid(),
  title: z.string(),
  start_date: z.string(), // date (YYYY-MM-DD)
  end_date: z.string(),
  destination_countries: z.array(z.string()),
  timezone: z.string(),
  primary_local_currency: z.string(),
  settlement_currency: z.string(),
  settlement_status: z.enum(["open", "finalized"]),
});

/** 공개 응답 DTO(TripRow + my_member_id). detail/create/patch 공용 — 셋 다 멤버/생성자 스코프라 my_member_id 해석 가능. */
export const tripResponseSchema = tripRowShape
  .extend({ my_member_id: z.string().uuid() }) // 호출자 자신의 trip_members.id (user_id는 절대 노출 안 함)
  .openapi("Trip");

/** 목록 아이템 DTO(TripRow + my_member_id/my_role + settlement축 net). GET /v1/trips 전용. */
export const tripListItemSchema = tripRowShape
  .extend({
    my_member_id: z.string().uuid(),
    my_role: z.enum(["admin", "member"]),
    // settlement축 개인 net(total_paid − total_share), 부호 있는 minor-unit STRING. compute 오류 trip만 null.
    my_net_amount: z
      .string()
      .regex(/^-?\d+$/)
      .nullable(),
    net_currency: z.string(), // = trip.settlement_currency
  })
  .openapi("TripListItem");

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

// 생성 입력에만 있는 어드민 표시 이름(§6.1) — trips 컬럼 아님(생성자 멤버십 display_name으로). 초대와 동일 규약.
// 선택: 미입력 시 서비스가 Google 계정 이름(actor.name)으로 폴백. tripFields에 넣지 않음(updateTrip 오염 방지).
export const createTripSchema = tripFields
  .extend({ admin_display_name: displayName.optional() })
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

// 삭제 결과 DTO — {id, deleted:true}. FE codegen SSOT(openapi.json).
export const deleteTripResponseSchema = z
  .object({ id: z.string().uuid(), deleted: z.literal(true) })
  .openapi("DeleteTripResult");
// DB row(트립 컬럼만) — repo create/findById/update 반환. TripResponse = TripRow + my_member_id.
export type TripRow = z.infer<typeof tripRowShape>;
export type TripResponse = z.infer<typeof tripResponseSchema>;
export type TripListItem = z.infer<typeof tripListItemSchema>;
// listForUser 반환 — DB에서 조인으로 얻는 TripRow + 호출자 멤버십(id·role). net은 서비스가 별도 주입.
export type TripListRow = TripRow & { my_member_id: string; my_role: "admin" | "member" };
export type CreateTrip = z.infer<typeof createTripSchema>;
// trips 테이블 컬럼(admin_display_name 제외) — repo.create가 받는 형태.
export type CreateTripColumns = z.infer<typeof tripFields>;
export type UpdateTrip = z.infer<typeof updateTripSchema>;
export type DeleteTripResult = z.infer<typeof deleteTripResponseSchema>;
