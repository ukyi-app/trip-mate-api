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

type Args = {
  namespace: string;
  cert: string;
  dryRun: boolean;
  config?: string;
  env?: string;
  app?: string;
  out?: string;
};
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
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    )
      val = val.slice(1, -1);
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
if (res.status !== 0)
  die(`kubeseal 종료 코드 ${res.status} — cert/컨트롤러 점검 (stderr는 값 미포함 시에만 확인)`);
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, res.stdout);
console.log(`sealed: ${args.out} (keys: ${targets.map((t) => t.envKey).join(", ")})`);
