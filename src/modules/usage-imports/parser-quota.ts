import type Redis from "ioredis";
import { checkDualQuota, refundDualQuota } from "../../core/rate-limit.ts";

export interface ParserQuotaOpts {
  userMax: number;
  userWindowSec: number;
  tripMax: number;
  tripWindowSec: number;
}

export type QuotaResult = { ok: true } | { ok: false; retryAfter: number };
export type ParserQuotaCheck = (userId: string, tripId: string) => Promise<QuotaResult>;
export type ParserQuotaRefund = (userId: string, tripId: string) => Promise<void>;
export interface ParserQuota {
  check: ParserQuotaCheck;
  refund: ParserQuotaRefund; // 파서 슬롯 예약 실패(busy) 등 작업 미수행 시 소비 환불
}

const userKey = (userId: string) => `pq:u:${userId}`;
const tripKey = (tripId: string) => `pq:t:${tripId}`;

/** 사용내역 파싱 전용 쿼터(원자 user·trip 이중, all-or-nothing).
 *  컨트롤러 흐름: context·check(소비)는 슬롯 없이 먼저 → tryAcquire는 parse 주변만 → busy면 refund.
 *  → 느린 I/O가 슬롯을 잡지 않고(false busy 방지), busy가 쿼터를 태우지 않는다(refund). */
export function createParserQuota(redis: Redis, opts: ParserQuotaOpts): ParserQuota {
  return {
    check: (userId, tripId) =>
      checkDualQuota(redis, {
        userKey: userKey(userId),
        userMax: opts.userMax,
        userWindowSec: opts.userWindowSec,
        tripKey: tripKey(tripId),
        tripMax: opts.tripMax,
        tripWindowSec: opts.tripWindowSec,
      }),
    refund: (userId, tripId) =>
      refundDualQuota(redis, { userKey: userKey(userId), tripKey: tripKey(tripId) }),
  };
}
