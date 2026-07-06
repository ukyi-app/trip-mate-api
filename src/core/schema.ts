import { z } from "@hono/zod-openapi";

/** 표시 이름 공용 스키마 — 앞뒤 공백 트림 후 1..60자(공백-only 거부). trip 어드민(§6.1)·초대 멤버 공용. */
export const displayName = z.string().trim().min(1).max(60);
