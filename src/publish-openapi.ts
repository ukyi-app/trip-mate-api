import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// openapi.json을 Cloudflare R2(S3 호환)에 수동 발행. CI publish-openapi 잡과 동일 경로(aws s3 cp).
// 실행: bun run publish:openapi  (자격증명은 R2_* 환경변수, aws CLI 필요)
export interface R2Config {
  endpoint: string;
  bucket: string;
  key: string;
}

/** R2 발행 환경변수 해석. 누락 시 어떤 변수가 빠졌는지 명시. (순수 — 테스트 가능)
 *  자격증명(R2_ACCESS_KEY_ID/SECRET)은 존재만 검증하고 aws CLI에 AWS_* 로 전달. */
export function resolveR2Config(env: Record<string, string | undefined>): R2Config {
  const required = [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET",
  ] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0)
    throw new Error(
      `R2 환경변수 누락: ${missing.join(", ")} — docs/contract-consumption.md(수동 발행) 참고.`,
    );
  return {
    endpoint: env.R2_ENDPOINT as string,
    bucket: env.R2_BUCKET as string,
    key: env.R2_OBJECT_KEY ?? "openapi.json",
  };
}

if ((import.meta as { main?: boolean }).main) {
  const env = process.env;
  const cfg = resolveR2Config(env);
  if (!existsSync("openapi.json"))
    throw new Error("openapi.json 없음 — 먼저 `bun run gen:openapi` 실행.");
  execFileSync(
    "aws",
    [
      "s3",
      "cp",
      "openapi.json",
      `s3://${cfg.bucket}/${cfg.key}`,
      "--endpoint-url",
      cfg.endpoint,
      "--content-type",
      "application/json",
      "--cache-control",
      "no-cache",
    ],
    {
      stdio: "inherit",
      env: {
        ...env,
        AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID as string,
        AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY as string,
        AWS_DEFAULT_REGION: "auto",
      },
    },
  );
  console.log(`발행 완료: ${cfg.bucket}/${cfg.key}`);
}
