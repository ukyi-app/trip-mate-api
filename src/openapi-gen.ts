import { writeFileSync } from "node:fs";
import { buildV1App } from "./app.ts";

// **순수 생성(finding #4 pass3):** env/config·createDb·redis·auth 일절 import 안 함.
// 스펙은 라우트 config(스키마)만 읽으므로 service/resolver/lookup은 stub, 핸들러 미실행 → 무-IO. CI/FE codegen에서 env 없이 동작.
const v1 = buildV1App({
  tripsService: {} as never,
  membersService: {} as never,
  expensesService: {} as never,
  settlementsService: {} as never,
  tripDefaults: {} as never,
  resolver: async () => null,
  emailOf: async () => "",
  nameOf: async () => "",
  memberLookup: async () => null,
  idempotencyStore: null,
  webOrigins: ["http://localhost:5173"], // 정적 — env 불요
});
const doc = v1.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "trip-mate API", version: "1.0.0" },
});
writeFileSync("openapi.json", JSON.stringify(doc, null, 2));
console.log("openapi.json written:", Object.keys(doc.paths ?? {}).length, "paths");
