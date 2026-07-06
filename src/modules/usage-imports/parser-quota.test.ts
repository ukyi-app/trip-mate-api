import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createParserQuota } from "./parser-quota.ts";

let container: StartedRedisContainer;
let redis: Redis;
beforeAll(async () => {
  container = await new RedisContainer("redis:7").start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

const quota = () =>
  createParserQuota(redis, { userMax: 2, userWindowSec: 60, tripMax: 3, tripWindowSec: 60 });
const check = () => quota().check;

describe("createParserQuotaCheck — per-user·per-trip 원자 이중 쿼터", () => {
  it("user 상한 초과 → ok:false + retryAfter", async () => {
    const c = check();
    expect((await c("u-1", "t-a")).ok).toBe(true);
    expect((await c("u-1", "t-b")).ok).toBe(true); // 다른 trip이어도 같은 user 카운트
    const r = await c("u-1", "t-c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("trip 상한 초과 → ok:false (여러 user가 같은 trip 소진)", async () => {
    const c = check();
    for (const u of ["ua", "ub", "uc"]) expect((await c(u, "t-shared")).ok).toBe(true);
    expect((await c("ud", "t-shared")).ok).toBe(false);
  });

  it("trip 거부가 user 쿼터를 소모하지 않는다(원자 all-or-nothing)", async () => {
    const c = check();
    for (const u of ["a1", "a2", "a3"]) expect((await c(u, "t-atomic")).ok).toBe(true); // trip 3 소진
    expect((await c("victim", "t-atomic")).ok).toBe(false); // trip 초과 → 거부
    // victim의 user 쿼터는 위 거부로 안 태워짐 → 다른 trip에서 여전히 2회 가능
    expect((await c("victim", "other-1")).ok).toBe(true);
    expect((await c("victim", "other-2")).ok).toBe(true);
  });

  it("refund → 소비 되돌림(busy 시 쿼터 미소모 효과)", async () => {
    const q = quota();
    expect((await q.check("ru", "rt")).ok).toBe(true); // user 1/2
    expect((await q.check("ru", "rt")).ok).toBe(true); // user 2/2
    await q.refund("ru", "rt"); // 되돌림 → user 1/2
    expect((await q.check("ru", "rt")).ok).toBe(true); // 여유 → 통과(환불 없으면 거부)
  });

  it("refund는 0 미만으로 내려가지 않는다(중복 환불 안전)", async () => {
    const q = quota();
    await q.refund("z", "zt"); // 소비 없이 환불 → 0 유지
    expect((await q.check("z", "zt")).ok).toBe(true);
    expect((await q.check("z", "zt")).ok).toBe(true);
    expect((await q.check("z", "zt")).ok).toBe(false); // user 상한(2) 도달(음수 미발생)
  });
});
