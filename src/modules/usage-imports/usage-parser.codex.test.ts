import { describe, expect, it } from "vitest";
import { UnavailableError, UpstreamError } from "../../core/errors.ts";
import {
  CODEX_OUTPUT_SCHEMA,
  CodexUsageParser,
  assertCodexToolsDisabled,
  buildCodexEnv,
  buildCodexPrompt,
  codexAuthAvailable,
  findExecutableOnPath,
  normalizeDrafts,
  seedCodexHome,
  writeCodexHome,
} from "./usage-parser.codex.ts";

describe("buildCodexPrompt (순수)", () => {
  it("도구 금지 문구·기준일·redact된 텍스트를 포함한다", () => {
    const p = buildCodexPrompt({
      text: "신한카드 010-1111-2222 스타벅스 6,500원 승인",
      referenceDate: "2026-07-06",
    });
    expect(p).toContain("도구");
    expect(p).toContain("2026-07-06");
    expect(p).toContain("스타벅스");
    expect(p).not.toContain("010-1111-2222");
  });
});

describe("CODEX_OUTPUT_SCHEMA (OpenAI strict 계약 앵커)", () => {
  const item = CODEX_OUTPUT_SCHEMA.properties.drafts.items;
  it("draft 아이템의 모든 프로퍼티가 required에 있다(strict 요구)", () => {
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });
  it("선택 필드는 null 유니온이다", () => {
    expect(item.properties.category.type).toContain("null");
    expect(item.properties.card_billed_amount.type).toContain("null");
  });
});

describe("writeCodexHome (부팅 materialize — env→파일)", () => {
  it("auth.json을 baseDir에 0600으로 쓰고 CODEX_HOME 경로를 반환한다", async () => {
    const { mkdtemp, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "codex-home-test-"));
    const authJson = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt"}}';
    const home = writeCodexHome(authJson, base);
    expect(home).toBe(base);
    const written = await readFile(join(base, "auth.json"), "utf8");
    expect(written).toBe(authJson);
    if (process.platform !== "win32") {
      const st = await stat(join(base, "auth.json"));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
  it("빈/공백 authJson이면 쓰지 않고 throw(오설정 fail-fast)", () => {
    expect(() => writeCodexHome("  ", "/tmp/x")).toThrow();
  });
  it("기존 auth.json이 심링크면 거부(예측가능 경로 심링크 공격 차단)", async () => {
    const { mkdtemp, symlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "codex-home-sym-"));
    const outside = join(base, "outside.txt");
    await writeFile(outside, "x");
    await symlink(outside, join(base, "auth.json"));
    expect(() => writeCodexHome('{"a":1}', base)).toThrow();
  });
  it("기존 일반 auth.json은 원자 교체(권한 복구)", async () => {
    const { mkdtemp, writeFile, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "codex-home-repl-"));
    await writeFile(join(base, "auth.json"), "stale", { mode: 0o644 });
    writeCodexHome('{"fresh":1}', base);
    expect(await readFile(join(base, "auth.json"), "utf8")).toBe('{"fresh":1}');
    if (process.platform !== "win32") {
      const st = await stat(join(base, "auth.json"));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

describe("seedCodexHome (부팅 — 기존 auth 보존)", () => {
  it("auth.json 없으면 seed를 쓴다", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "codex-seed-abs-"));
    seedCodexHome('{"seed":1}', base);
    expect(await readFile(join(base, "auth.json"), "utf8")).toBe('{"seed":1}');
  });
  it("기존 auth.json(제자리 refresh분)은 stale seed로 덮어쓰지 않는다", async () => {
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "codex-seed-keep-"));
    await writeFile(join(base, "auth.json"), '{"refreshed":1}', { mode: 0o600 });
    seedCodexHome('{"stale-seed":1}', base);
    expect(await readFile(join(base, "auth.json"), "utf8")).toBe('{"refreshed":1}');
  });
});

describe("codexAuthAvailable (순수) — 주입 게이트", () => {
  it("USAGE_PARSER_CODEX_AUTH env 있으면 true(파일 확인 없이)", () => {
    expect(codexAuthAvailable("{...}", () => false)).toBe(true);
  });
  it("env 없어도 ~/.codex/auth.json 존재하면 true(로컬 폴백)", () => {
    expect(codexAuthAvailable(undefined, (p) => p.endsWith("auth.json"))).toBe(true);
  });
  it("env 없고 파일도 없으면 false(prod 오설정 → 깨끗한 off)", () => {
    expect(codexAuthAvailable(undefined, () => false)).toBe(false);
  });
});

describe("findExecutableOnPath (순수) — bwrap 강제 검출", () => {
  it("PATH의 디렉토리에서 실행파일을 찾으면 경로 반환", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === "/usr/bin/bwrap";
    };
    expect(findExecutableOnPath("bwrap", "/sbin:/usr/bin", exists)).toBe("/usr/bin/bwrap");
  });
  it("어디에도 없으면 null", () => {
    expect(findExecutableOnPath("bwrap", "/sbin:/usr/bin", () => false)).toBe(null);
  });
  it("PATH 비어있으면 null(throw 안 함)", () => {
    expect(findExecutableOnPath("bwrap", undefined, () => true)).toBe(null);
  });
});

describe("assertCodexToolsDisabled (부팅 강제 — bwrap 있으면 fail-closed)", () => {
  it("bwrap 검출되면 throw(셸 도구 재활성 차단)", () => {
    expect(() => assertCodexToolsDisabled("/usr/bin", () => true)).toThrow();
  });
  it("bwrap 없으면 통과", () => {
    expect(() => assertCodexToolsDisabled("/usr/bin", () => false)).not.toThrow();
  });
});

describe("buildCodexEnv (순수) — 앱 시크릿 env 비상속(critical 리뷰 반영)", () => {
  it("allowlist(PATH·HOME·CODEX_HOME 등)만 통과시키고 앱 시크릿은 제외한다", () => {
    const env = buildCodexEnv({
      PATH: "/usr/bin",
      HOME: "/home/app",
      CODEX_HOME: "/codex",
      TRIP_MATE_DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "s3cret",
      ANTHROPIC_API_KEY: "sk-x",
      RESEND_API_KEY: "re-x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/app", CODEX_HOME: "/codex" });
  });
  it("미설정 allowlist 키는 만들지 않는다", () => {
    expect(buildCodexEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("normalizeDrafts (순수)", () => {
  it("null 값 키를 제거해 zod optional과 정합시킨다", () => {
    const out = normalizeDrafts({
      drafts: [{ title: "스타벅스", category: null, card_billed_amount: null }],
    });
    expect(out).toEqual({ drafts: [{ title: "스타벅스" }] });
  });
  it("drafts 형태가 아니면 그대로 반환(검증은 validateDrafts 몫)", () => {
    expect(normalizeDrafts(null)).toBe(null);
    expect(normalizeDrafts({ drafts: "x" })).toEqual({ drafts: "x" });
  });
});

describe("CodexUsageParser (fake run 주입)", () => {
  const DRAFT_JSON = JSON.stringify({
    drafts: [
      {
        title: "스타벅스",
        local_amount: "6500",
        local_currency: "KRW",
        spent_at: "2026-07-05T03:30:00Z",
        category: null,
        payment_method: "card",
        card_billed_amount: null,
        card_billed_currency: null,
        confidence: 0.9,
      },
    ],
  });

  it("run 출력 JSON을 정규화·검증해 초안 반환, 프롬프트에 redact 텍스트 전달", async () => {
    const prompts: string[] = [];
    const parser = new CodexUsageParser({
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return DRAFT_JSON;
      },
    });
    const drafts = await parser.parse({
      text: "07/05 스타벅스 6,500원 승인",
      referenceDate: "2026-07-06",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe("스타벅스");
    expect(drafts[0]!.category).toBeUndefined();
    expect(prompts[0]).toContain("스타벅스");
    expect(prompts[0]).toContain("2026-07-06");
  });

  it("run 실패 → UpstreamError로 정규화", async () => {
    const parser = new CodexUsageParser({
      run: async () => {
        throw new Error("codex died");
      },
    });
    await expect(parser.parse({ text: "x", referenceDate: "2026-07-06" })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("비정형 출력(JSON 아님) → UpstreamError", async () => {
    const parser = new CodexUsageParser({ run: async () => "not json" });
    await expect(parser.parse({ text: "x", referenceDate: "2026-07-06" })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("직렬화(동시 1) — 두 번째 동시 요청은 대기 없이 UnavailableError", async () => {
    // 동시 1: seed CODEX_HOME 제자리 토큰 리프레시의 torn-write·rotation 소실 방지(파드 고갈도 함께).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const parser = new CodexUsageParser({
      run: async () => {
        await gate;
        return DRAFT_JSON;
      },
    });
    const input = { text: "x", referenceDate: "2026-07-06" };
    const p1 = parser.parse(input);
    await expect(parser.parse(input)).rejects.toBeInstanceOf(UnavailableError);
    release();
    await expect(p1).resolves.toHaveLength(1);
    // 슬롯 반환 후에는 다시 실행 가능
    await expect(parser.parse(input)).resolves.toHaveLength(1);
  });
});
