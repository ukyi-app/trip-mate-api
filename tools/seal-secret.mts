// .env → SealedSecret 봉인 CLI (`pnpm secret:seal`).
// .env의 UPPER_SNAKE 키가 봉인 대상의 SSOT다. .app-config.yml에는 시크릿 키 목록을 쓰지 않는다.
// 평문 Secret manifest는 디스크에 쓰지 않고 kubeseal stdin으로만 흐른다.
// 이 사본은 homelab 마이그레이션/테스트용 — 동일 스크립트가 app-starter 템플릿에도 동봉된다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

function die(msg: string): never {
  console.error(`seal-secret: ${msg}`);
  process.exit(1);
}

type Args = { namespace: string; cert: string; dryRun: boolean; config?: string; env?: string; app?: string; out?: string };
function parseArgs(argv: string[]): Args {
  const args: Args = { namespace: "prod", cert: "tools/sealed-secrets-cert.pem", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--env") args.env = argv[++i];
    else if (a === "--cert") args.cert = argv[++i];
    else if (a === "--app") args.app = argv[++i];
    else if (a === "--namespace") args.namespace = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else die(`알 수 없는 인자: ${a}`);
  }
  if (!args.config || !args.env) die("--config <.app-config.yml> --env <.env> 필수");
  return args;
}

function parseDotEnv(path: string) {
  const out = new Map();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let val = line.slice(eq + 1).trim();
    // .env 관례: 양끝 매칭 따옴표는 구분자라 벗긴다(미제거 시 봉인 값에 따옴표 혼입 + F2 거부 우회).
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) val = val.slice(1, -1);
    out.set(line.slice(0, eq).trim(), val);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
readFileSync(args.config!, "utf8"); // 존재/읽기 가능성만 확인한다. 시크릿 키 목록은 .env가 SSOT.
const envMap = parseDotEnv(args.env!);
const envKeys = [...envMap.keys()].sort();
const bad = envKeys.filter((key) => !/^[A-Z][A-Z0-9_]*$/.test(key));
if (bad.length > 0) die(`봉인 대상은 UPPER_SNAKE .env 키만 지원: ${bad.join(", ")}`);
if (envKeys.length === 0) die(".env에 봉인할 대상이 없다");

// homelab이 프로비저닝한 DB라면 접속 URL은 플랫폼이 스스로 주입한다 — 그걸 또 봉인하면 실수다.
// ★죽이지 않고 경고만 한다(ADR-0002의 '아래에 하드 게이트가 있으면 경고만' 규율): homelab이 프로비저닝하지
//   않는 외부 DB(관리형 Postgres·서드파티)를 쓰는 앱은 자기 URL을 봉인하는 게 유일한 방법이다.
//   여기서 하드 실패시키면 그 앱은 봉인 자체를 못 한다.
// ★그래서 경고는 '봉인해도 되는 조건'을 말해야 한다 — 아래 하드 게이트가 무는 조건과 같은 이야기여야 한다:
//   api 아키타입의 src/db.ts는 런타임 URL 후보(<DB>_DATABASE_URL 꼴)가 둘 이상이면 기동에서 죽는다.
//   즉 봉인한 DB URL 키 + 플랫폼 주입 키가 겹치는 순간 CrashLoop다. 조건은 하나다: 이 앱에 homelab DB가 없을 것.
// ★이 파일은 4개 아키타입이 공유한다 — src/db.ts가 없는 아키타입(site·worker·fullstack)에 없는 파일을 가리키지
//   않도록, 죽는 주체를 'api 아키타입'으로 명시한다.
const dbKeys = envKeys.filter((k) => k.endsWith("DATABASE_URL"));
if (dbKeys.length > 0) {
  console.error(
    `⚠️  seal-secret: DB 접속 URL로 보이는 키를 봉인한다: ${dbKeys.join(", ")}\n` +
      `    봉인이 정당한 경우는 하나뿐이다 — homelab이 이 앱에 DB를 프로비저닝하지 *않을* 때(외부·관리형 DB).\n` +
      `    homelab이 DB를 프로비저닝하면(create-database) conn SealedSecret이 <DB>_DATABASE_URL을 파드에 직접\n` +
      `    주입한다(<DB> = 앱 이름이 아니라 DB 이름의 UPPER_SNAKE). 그때 봉인한 이 키가 함께 보이면 api 아키타입의\n` +
      `    src/db.ts는 런타임 URL 후보를 둘로 보고 *기동에서 죽는다*(CrashLoop) — 어느 DB가 이 앱 것인지 정할 수\n` +
      `    없기 때문이다. 소스를 하나만 골라라:\n` +
      `      · homelab DB를 쓴다 → 이 키를 .env에서 빼라. 로컬 개발용 URL은 .env.local에(봉인 대상 아님, bun이 자동 로드).\n` +
      `      · 외부 DB를 쓴다   → 이 경고는 무시해도 된다. 단 이 앱에 create-database를 돌리지 마라.\n` +
      `      · 둘 다 필요하다   → 자동 발견을 포기하고 풀을 직접 만들어 createApp(pool)로 넘겨라(api: src/db.ts 우회).`,
  );
}

const targets: { envKey: string }[] = envKeys.map((envKey) => ({ envKey }));

if (args.dryRun) {
  // 봉인 없이 대상 키 목록만 (값 절대 미포함)
  console.log(JSON.stringify({ seal: targets.map((t) => t.envKey) }, null, 2));
  process.exit(0);
}

args.app = args.app ?? process.env.APP ?? basename(process.cwd());
if (!/^[a-z][a-z0-9-]*$/.test(args.app)) die(`--app <name> 형식 불량: ${args.app}`);
args.out = args.out ?? `deploy/${args.app}-secrets.sealed.yaml`;

// 평문 Secret manifest는 메모리에서만 조립해 kubeseal stdin으로 직행
const stringData = Object.fromEntries(targets.map((t) => [t.envKey, envMap.get(t.envKey)]));
const manifest = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: `${args.app}-secrets`, namespace: args.namespace },
  type: "Opaque",
  stringData,
};

const res = spawnSync("kubeseal", ["--cert", args.cert, "--format", "yaml"], {
  input: JSON.stringify(manifest), // kubeseal은 JSON manifest도 받는다(YAML 슈퍼셋)
  encoding: "utf8",
});
if (res.error) die(`kubeseal 실행 실패: ${res.error.message}`);
if (res.status !== 0) die(`kubeseal 종료 코드 ${res.status} — cert/컨트롤러 점검 (stderr는 값 미포함 시에만 확인)`);
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, res.stdout);
console.log(`sealed: ${args.out} (keys: ${targets.map((t) => t.envKey).join(", ")})`);
