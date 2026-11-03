/**
 * テスト専用DB（docker-compose.test.yml）の Docker ラッパー（2-5）。
 *
 *   npm run testdb:check   … .env.test・Compose の環境変数・`docker compose config` の結果を検証する（コンテナは操作しない）
 *   npm run testdb:status  … katana-test プロジェクトのコンテナと、開発用ボリュームの状態を読み取るだけ
 *
 * - docker compose には、必ず `--project-name katana-test --file <絶対パス> --project-directory <katana-web>
 *   --env-file <katana-web/.env.test>` を付ける。外部から Docker・Compose の引数を渡す経路はない。
 * - 実行できる Docker のコマンドは、読み取り専用のものだけ（READ_ONLY_COMMANDS）。up・down・reset などの、
 *   コンテナを作成・起動・停止・削除するモードは、必要な安全条件がそろうまで実装しない（未対応の引数として拒否する）。
 * - 子プロセスは shell を使わずに起動し、環境変数は許可リストの変数と、検証済みの2つのパスワードだけを渡す。
 * - パスワード・接続URL・`docker compose config` の出力の全文は表示しない。失敗したときはエラーコードだけを表示する。
 *
 * 検証の関数はこのファイルから export し、単体テストから読み込む。直接実行したときだけ main() が動く。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  TEST_DB_ADMIN_PASSWORD_KEY,
  TEST_DB_APP_PASSWORD_KEY,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../lib/db/testDatabaseGuard.ts";
import { DEVELOPMENT_ENV_FILE, inheritAllowedEnv, IntegrationRunnerError, readEnvFile, TEST_ENV_FILE } from "../lib/testing/integrationEnv.ts";

export const COMPOSE_PROJECT = "katana-test";
export const COMPOSE_FILE = "docker-compose.test.yml";
export const TEST_SERVICE = "test-db";
export const TEST_CONTAINER = "katana-test-db";
/** 開発用DBのボリューム（読み取るだけ。削除・変更・マウントはしない） */
export const DEVELOPMENT_VOLUME = "katana-web_postgres_data";
/** Step 3-9（R12）で記録した Docker のコンテキスト */
export const EXPECTED_DOCKER_CONTEXT = "desktop-linux";
const INIT_DIR = path.join("docker", "test-db", "init");
const INIT_FILES = [path.join(INIT_DIR, "01-app-role.sh"), path.join(INIT_DIR, "02-marker.sql")];
const DATA_DIR = "/var/lib/postgresql/data";
/** 開発用ボリュームの比較に使う項目（名前・作成日時・Compose のラベル）。中身は読まない */
const DEVELOPMENT_VOLUME_FORMAT = '{{.Name}}\t{{.CreatedAt}}\t{{index .Labels "com.docker.compose.project"}}\t{{index .Labels "com.docker.compose.volume"}}';
const INIT_TARGET = "/docker-entrypoint-initdb.d";

/** .env.test に書いてよいキー（Compose の --env-file は COMPOSE_* なども読むので、これ以外を拒否する） */
const APP_PASSWORD_KEY = TEST_DB_APP_PASSWORD_KEY;
const ADMIN_PASSWORD_KEY = TEST_DB_ADMIN_PASSWORD_KEY;
const TEST_ENV_KEYS = ["DATABASE_URL", APP_PASSWORD_KEY, ADMIN_PASSWORD_KEY];
/** Docker・Compose の接続先・読み込みを変える変数。親に設定されていたら停止する */
const DOCKER_TARGET_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT"];
/** 子プロセスの環境変数に含まれていてはいけない変数（組み立てた後の再確認に使う） */
const FORBIDDEN_CHILD_ENV = /^(DATABASE_URL$|PG|DOTENV_|COMPOSE_|POSTGRES_|DOCKER_|NODE_OPTIONS$)/;

export type TestDbErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "DOCKER_TARGET_ENV_PRESENT"
  | "TEST_ENV_MISSING"
  | "TEST_ENV_UNEXPECTED_KEY"
  | "TARGET_REJECTED"
  | "APP_PASSWORD_MISSING"
  | "ADMIN_PASSWORD_MISSING"
  | "PASSWORD_PLACEHOLDER"
  | "PASSWORD_CHARSET"
  | "URL_PASSWORD_MISMATCH"
  | "ADMIN_PASSWORD_SAME_AS_APP"
  | "CHILD_ENV_INVALID"
  | "REQUIRED_FILE_MISSING"
  | "DOCKER_COMMAND_NOT_ALLOWED"
  | "DOCKER_COMMAND_FAILED"
  | "DOCKER_CONTEXT_MISMATCH"
  | "COMPOSE_CONFIG_INVALID"
  | "COMPOSE_CONFIG_MISMATCH"
  | "STATUS_UNEXPECTED_CONTAINER";

export class TestDbError extends Error {
  readonly code: TestDbErrorCode;

  constructor(code: TestDbErrorCode, detail: string) {
    super(`[testdb] ${code}: ${detail}`);
    this.name = "TestDbError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type TestDbMode = "check" | "status";
export type CommandResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd: string; env: Record<string, string>; shell: false };

export type TestDbDeps = {
  /** katana-web/ の絶対パス */
  root: string;
  argv: readonly string[];
  execArgv: readonly string[];
  parentEnv: EnvSource;
  /** env ファイルを dotenv.parse で読む。ファイルがなければ undefined */
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** 子プロセスを起動し、出力を受け取る（表示はしない） */
  run: (command: string, args: readonly string[], options: RunOptions) => Promise<CommandResult>;
  log: (text: string) => void;
};

export function parseTestDbArgs(args: readonly string[]): TestDbMode {
  if (args.length === 1 && args[0] === "--check") return "check";
  if (args.length === 1 && args[0] === "--status") return "status";
  throw new TestDbError("ARGUMENTS_INVALID", "the only accepted arguments are --check or --status.");
}

export type VerifiedTestDbEnv = {
  target: TestDatabaseTarget;
  databaseUrl: string;
  appPassword: string;
  adminPassword: string;
};

/**
 * `.env.test`（dotenv.parse した結果）を検証する（R14）。DBには接続しない。
 * キーが3つだけであること（Compose の動作を変えるキーを入れさせない。ラッパーだけの条件）を確かめた後、
 * DATABASE_URL を assertTestDatabaseTarget() で、パスワードを assertTestDatabaseCredentials() で検証する。
 * パスワードの検証は、runner・testdb-migrate・Prisma CLI のテストDBモードと共通。エラーコードは共通の関数のものをそのまま使う。
 */
export function verifyTestDbEnv(testEnv: EnvSource | undefined, developmentEnv: EnvSource | undefined): VerifiedTestDbEnv {
  if (testEnv === undefined) {
    throw new TestDbError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found; create it from .env.test.example.`);
  }
  const unexpected = Object.keys(testEnv).filter((key) => !TEST_ENV_KEYS.includes(key));
  if (unexpected.length > 0) {
    // キーの名前は秘密情報ではないので表示する
    throw new TestDbError("TEST_ENV_UNEXPECTED_KEY", `${TEST_ENV_FILE} has unexpected keys: ${unexpected.sort().join(", ")}.`);
  }

  const databaseUrl = testEnv.DATABASE_URL;
  let target: TestDatabaseTarget;
  try {
    target = assertTestDatabaseTarget({ databaseUrl, env: {}, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    throw error;
  }

  let credentials: { appPassword: string; adminPassword: string };
  try {
    credentials = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      // URL_INVALID は、assertTestDatabaseTarget() を通った後には起きない
      if (error.code === "URL_INVALID") throw new TestDbError("TARGET_REJECTED", "the test database target was rejected (URL_INVALID).");
      // 共通の関数の説明には、パスワード・接続URLが含まれない
      throw new TestDbError(error.code, error.detail);
    }
    throw error;
  }
  return { target, databaseUrl: databaseUrl as string, ...credentials };
}

/**
 * Compose の子プロセスの環境変数（R15）。親からは許可リストの変数だけを引き継ぎ、2つのパスワードは検証済みの値を明示的に設定する。
 * Compose の変数展開ではシェルの環境変数が --env-file より優先されるため、親の同名の変数は使わない。
 */
export function buildComposeEnv(parentEnv: EnvSource, verified: VerifiedTestDbEnv): { childEnv: Record<string, string>; droppedKeys: string[] } {
  const { inherited, droppedKeys } = inheritAllowedEnv(parentEnv);
  const childEnv = { ...inherited, [APP_PASSWORD_KEY]: verified.appPassword, [ADMIN_PASSWORD_KEY]: verified.adminPassword };
  assertComposeEnv(childEnv, verified);
  return { childEnv, droppedKeys };
}

/** 組み立てた後の子プロセスの環境変数を、もう一度確かめる */
export function assertComposeEnv(childEnv: Readonly<Record<string, string>>, verified: VerifiedTestDbEnv): void {
  const forbidden = Object.keys(childEnv).filter((key) => FORBIDDEN_CHILD_ENV.test(key));
  const katanaKeys = Object.keys(childEnv).filter((key) => key.startsWith("KATANA_")).sort();
  if (
    forbidden.length > 0 ||
    JSON.stringify(katanaKeys) !== JSON.stringify([ADMIN_PASSWORD_KEY, APP_PASSWORD_KEY]) ||
    childEnv[APP_PASSWORD_KEY] !== verified.appPassword ||
    childEnv[ADMIN_PASSWORD_KEY] !== verified.adminPassword
  ) {
    throw new TestDbError("CHILD_ENV_INVALID", "the environment for docker compose is not the expected one.");
  }
}

/** docker compose の固定の引数。プロジェクト・Composeファイル・作業ディレクトリ・env ファイルは、すべて絶対パスで指定する */
export function composeArgs(root: string, subcommand: readonly string[]): string[] {
  return [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--file",
    path.join(root, COMPOSE_FILE),
    "--project-directory",
    root,
    "--env-file",
    path.join(root, TEST_ENV_FILE),
    ...subcommand,
  ];
}

/** 実行してよい Docker のコマンド（すべて読み取り専用） */
function isReadOnlyDockerCommand(root: string, args: readonly string[]): boolean {
  const same = (expected: readonly string[]) => expected.length === args.length && expected.every((value, i) => value === args[i]);
  return [
    ["context", "show"],
    composeArgs(root, ["config", "--quiet"]),
    composeArgs(root, ["config", "--format", "json"]),
    composeArgs(root, ["ps", "--all", "--format", "json"]),
    ["ps", "--all", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Names}}"],
    ["ps", "--all", "--filter", `name=^katana-db$`, "--format", "{{.Names}}\t{{.Status}}"],
    ["ps", "--all", "--filter", `volume=${DEVELOPMENT_VOLUME}`, "--format", "{{.Names}}"],
    ["volume", "ls", "--filter", `name=^${DEVELOPMENT_VOLUME}$`, "--format", "{{.Name}}"],
    ["volume", "inspect", DEVELOPMENT_VOLUME, "--format", DEVELOPMENT_VOLUME_FORMAT],
  ].some(same);
}

/** 表示する前に、パスワードと接続URLを伏せる */
function redact(text: string, verified: VerifiedTestDbEnv): string {
  let result = text;
  for (const secret of [verified.databaseUrl, verified.appPassword, verified.adminPassword]) result = result.split(secret).join("(hidden)");
  return result.replace(/postgres(ql)?:\/\/\S+/g, "(hidden)");
}

type Docker = (args: readonly string[]) => Promise<string>;

function makeDocker(deps: TestDbDeps, childEnv: Record<string, string>, verified: VerifiedTestDbEnv): Docker {
  return async (args) => {
    if (!isReadOnlyDockerCommand(deps.root, args)) {
      throw new TestDbError("DOCKER_COMMAND_NOT_ALLOWED", "only read-only docker commands are allowed.");
    }
    const result = await deps.run("docker", args, { cwd: deps.root, env: childEnv, shell: false });
    if (result.code !== 0) {
      const stderr = redact(result.stderr.trim(), verified).slice(0, 500);
      throw new TestDbError("DOCKER_COMMAND_FAILED", `docker ${args.includes("compose") ? "compose" : args[0]} exited with ${result.code}${stderr ? `: ${stderr}` : ""}`);
    }
    return result.stdout;
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- docker compose config の JSON を、形を確かめながら読む */
/**
 * `docker compose config --format json` の結果を検証する（2-5の操作前の確認）。不一致の項目名だけを含むエラーを投げる。
 * 戻り値は、表示してよい要約（パスワードを含まない）。
 */
export function verifyComposeConfig(json: string, root: string, verified: VerifiedTestDbEnv): string[] {
  let config: any;
  try {
    config = JSON.parse(json);
  } catch {
    throw new TestDbError("COMPOSE_CONFIG_INVALID", "docker compose config did not return JSON.");
  }
  const mismatches: string[] = [];
  const expect = (name: string, ok: boolean) => {
    if (!ok) mismatches.push(name);
  };

  expect("name", config?.name === COMPOSE_PROJECT);
  expect("top-level volumes", config?.volumes === undefined || Object.keys(config.volumes).length === 0);
  const services = config?.services ?? {};
  expect("services", JSON.stringify(Object.keys(services)) === JSON.stringify([TEST_SERVICE]));
  const s = services[TEST_SERVICE] ?? {};
  expect("container_name", s.container_name === TEST_CONTAINER);
  expect("image", s.image === "postgres:15");
  expect("restart", s.restart === "no");
  const ports = Array.isArray(s.ports) ? s.ports : [];
  expect(
    "ports",
    ports.length === 1 && ports[0].host_ip === "127.0.0.1" && String(ports[0].published) === "5434" && Number(ports[0].target) === 5432,
  );
  expect("tmpfs", JSON.stringify(s.tmpfs) === JSON.stringify([DATA_DIR]));
  const volumes = Array.isArray(s.volumes) ? s.volumes : [];
  expect(
    "volumes",
    volumes.length === 1 &&
      volumes[0].type === "bind" &&
      volumes[0].source === path.join(root, INIT_DIR) &&
      volumes[0].target === INIT_TARGET &&
      volumes[0].read_only === true,
  );
  expect("no volume-type mounts", volumes.every((v: any) => v?.type !== "volume"));
  expect("healthcheck", Array.isArray(s.healthcheck?.test) && s.healthcheck.test.length > 0 && s.healthcheck.disable !== true);
  const environment = s.environment ?? {};
  expect(
    "environment",
    JSON.stringify(Object.keys(environment).sort()) === JSON.stringify([APP_PASSWORD_KEY, "POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]) &&
      environment.POSTGRES_DB === "katana_test" &&
      environment.POSTGRES_USER === "postgres" &&
      environment.POSTGRES_PASSWORD === verified.adminPassword &&
      environment[APP_PASSWORD_KEY] === verified.appPassword,
  );
  for (const key of ["env_file", "privileged", "network_mode", "pid", "ipc", "cap_add", "devices", "extends"]) {
    expect(`no ${key}`, s[key] === undefined);
  }
  // 開発用DBのコンテナ名・ボリューム・ポートを参照していない（テスト用のコンテナ名は除いて調べる）
  const text = json.split(TEST_CONTAINER).join("");
  expect("no development references", !/katana-db|postgres_data|5433|katana-web_/.test(text));

  if (mismatches.length > 0) {
    throw new TestDbError("COMPOSE_CONFIG_MISMATCH", `docker compose config does not match: ${mismatches.join(", ")}.`);
  }
  return [
    `project: ${config.name}`,
    `service: ${TEST_SERVICE} (container ${s.container_name}, image ${s.image}, restart ${s.restart})`,
    `port: ${ports[0].host_ip}:${ports[0].published} -> ${ports[0].target}`,
    `data directory: tmpfs ${DATA_DIR} (no named or volume-type mounts)`,
    `init scripts: ${path.relative(root, volumes[0].source)} -> ${INIT_TARGET} (read-only bind)`,
    `healthcheck: ${s.healthcheck.test.join(" ")}`,
    `environment: POSTGRES_DB=katana_test, POSTGRES_USER=postgres, POSTGRES_PASSWORD=(hidden; matches ${ADMIN_PASSWORD_KEY}), ${APP_PASSWORD_KEY}=(hidden; matches)`,
  ];
}

/** `docker compose ps --format json` の出力（JSON配列、または1行ごとのJSON）を読む */
export function parseComposePs(stdout: string): any[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    if (trimmed.startsWith("[")) return JSON.parse(trimmed);
    return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw new TestDbError("DOCKER_COMMAND_FAILED", "docker compose ps did not return JSON.");
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const lines = (stdout: string) => stdout.split("\n").map((line) => line.trim()).filter(Boolean);

/** 手順どおりに検証し、成功したら0を返す。失敗したら TestDbError を投げる */
export async function runTestDb(deps: TestDbDeps): Promise<number> {
  const { root } = deps;

  // 1. 引数  2. Node の起動オプション  3. Docker の接続先を変える変数
  const mode = parseTestDbArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new TestDbError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running this script.");
  }
  const dockerTarget = DOCKER_TARGET_ENV.filter((key) => deps.parentEnv[key] !== undefined);
  if (dockerTarget.length > 0) {
    throw new TestDbError("DOCKER_TARGET_ENV_PRESENT", `unset ${dockerTarget.join(", ")} before running this script.`);
  }

  // 4. .env.test・.env  5. 検証（R14）  6. 子プロセスの環境変数（R15）
  const verified = verifyTestDbEnv(deps.readEnvFile(path.join(root, TEST_ENV_FILE)), deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE)));
  const { childEnv, droppedKeys } = buildComposeEnv(deps.parentEnv, verified);

  // 7. ファイル
  for (const relative of [COMPOSE_FILE, INIT_DIR, ...INIT_FILES]) {
    if (!deps.pathExists(path.join(root, relative))) throw new TestDbError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }

  // 8. Docker のコンテキスト（ファイルを読むだけで、デーモンには接続しない）
  const docker = makeDocker(deps, childEnv, verified);
  const context = (await docker(["context", "show"])).trim();
  if (context !== EXPECTED_DOCKER_CONTEXT) {
    throw new TestDbError("DOCKER_CONTEXT_MISMATCH", `the docker context is not ${EXPECTED_DOCKER_CONTEXT}.`);
  }

  // 9. Compose の構成（変数展開を含む）。出力は表示せず、プログラムの中で照合する
  await docker(composeArgs(root, ["config", "--quiet"]));
  const summary = verifyComposeConfig(await docker(composeArgs(root, ["config", "--format", "json"])), root, verified);

  const header = [
    `[testdb] ${mode} mode: no container was created, started, stopped or removed, and no database connection was made.`,
    "",
    `connection target: verified ${verified.target.host}:${verified.target.port}/${verified.target.database} as ${verified.target.user} (password hidden)`,
    `passwords: ${TEST_ENV_FILE} values verified (not placeholders, allowed characters, URL password matches, admin differs)`,
    `docker context: ${context}`,
    `child environment: ${Object.keys(childEnv).sort().join(", ")} (password values hidden); dropped ${droppedKeys.length} variable(s) from the parent`,
    "",
    "docker compose config:",
    ...summary.map((line) => `  ${line}`),
  ];
  if (mode === "check") {
    deps.log(header.join("\n"));
    return 0;
  }

  // --status：katana-test プロジェクトのコンテナと、開発用DBの記録を読むだけ
  const containers = parseComposePs(await docker(composeArgs(root, ["ps", "--all", "--format", "json"])));
  const labeled = lines(await docker(["ps", "--all", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Names}}"]));
  const unexpected = [...containers.map((c) => String(c?.Name)), ...labeled].filter((name) => name !== TEST_CONTAINER);
  if (unexpected.length > 0) {
    throw new TestDbError("STATUS_UNEXPECTED_CONTAINER", `the ${COMPOSE_PROJECT} project has containers other than ${TEST_CONTAINER}.`);
  }
  const developmentContainer = lines(await docker(["ps", "--all", "--filter", "name=^katana-db$", "--format", "{{.Names}}\t{{.Status}}"]));
  const volumeExists = lines(await docker(["volume", "ls", "--filter", `name=^${DEVELOPMENT_VOLUME}$`, "--format", "{{.Name}}"])).includes(DEVELOPMENT_VOLUME);
  const developmentVolume = volumeExists ? lines(await docker(["volume", "inspect", DEVELOPMENT_VOLUME, "--format", DEVELOPMENT_VOLUME_FORMAT])) : [];
  const volumeUsers = lines(await docker(["ps", "--all", "--filter", `volume=${DEVELOPMENT_VOLUME}`, "--format", "{{.Names}}"]));
  deps.log(
    [
      ...header,
      "",
      `${COMPOSE_PROJECT} containers: ${containers.length === 0 ? "none" : containers.map((c) => `${c.Name} (${c.State ?? "unknown"}${c.Health ? `, ${c.Health}` : ""})`).join(", ")}`,
      `development container katana-db: ${developmentContainer.length === 0 ? "not present" : developmentContainer.join(", ")}`,
      `development volume (name, created, compose project, compose volume): ${developmentVolume.length === 0 ? "not present" : developmentVolume.join(", ")}`,
      `containers using the development volume: ${volumeUsers.length === 0 ? "none" : volumeUsers.join(", ")}`,
    ].join("\n"),
  );
  return 0;
}

function runCommand(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // 型の上で NODE_ENV が必須になっているだけなので、値は変えずに型だけ合わせる
    execFile(command, args, { ...options, env: options.env as NodeJS.ProcessEnv, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new TestDbError("DOCKER_COMMAND_FAILED", `docker could not be started (${String(error.code ?? "unknown")}).`));
        return;
      }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

function main(): void {
  runTestDb({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    parentEnv: process.env,
    readEnvFile,
    pathExists: existsSync,
    run: runCommand,
    log: (text) => console.log(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // 想定したエラーは、秘密情報を含まないメッセージだけを表示する
      console.error(error instanceof TestDbError || error instanceof IntegrationRunnerError ? error.message : error);
      process.exitCode = 1;
    },
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
