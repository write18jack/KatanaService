/**
 * テスト専用DB（docker-compose.test.yml）の Docker ラッパー（2-5）。
 *
 *   npm run testdb:check            … .env.test・Compose の環境変数・`docker compose config` の結果を検証する（コンテナは操作しない）
 *   npm run testdb:status           … katana-test プロジェクトのコンテナと、開発用ボリュームの状態を読み取るだけ
 *   npm run testdb:up               … 起動前の確認だけを行い、実行する予定のコマンドを表示する（コンテナは操作しない）
 *   npm run testdb:up -- --apply    … 確認がすべて通った場合だけ、テストDBのコンテナを作成・起動し、起動後の確認を行う
 *   npm run testdb:down             … 停止前の確認だけを行い、実行する予定のコマンドを表示する（コンテナは操作しない）
 *   npm run testdb:down -- --apply  … 確認がすべて通った場合だけ、katana-test プロジェクトのコンテナを停止・削除する
 *                                     （データは tmpfs にあるので失われる。ボリューム・イメージは削除しない）
 *
 * - docker compose には、必ず `--project-name katana-test --file <絶対パス> --project-directory <katana-web>
 *   --env-file <katana-web/.env.test>` を付ける。外部から Docker・Compose の引数を渡す経路はない。
 * - 実行できる Docker のコマンドは、読み取り専用の許可リスト（isReadOnlyDockerCommand）と、変更操作の2つ
 *   （UP_SUBCOMMAND・DOWN_SUBCOMMAND。`--apply` があるときだけ）に完全一致するものだけ。reset は実装しない。
 * - 変更操作では `--volumes`・`--remove-orphans`・`--rmi`・`--renew-anon-volumes`・`--force-recreate`・`--build` を使わない。
 *   操作の後の確認で失敗しても、コンテナ・ボリュームを自動で削除・作り直ししない（報告して止まる）。
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
  | "STATUS_UNEXPECTED_CONTAINER"
  | "MUTATION_NOT_ALLOWED"
  | "UNEXPECTED_CONTAINER"
  | "UNEXPECTED_SERVICE"
  | "UNEXPECTED_VOLUME"
  | "CONTAINER_NAME_CONFLICT"
  | "TEST_CONTAINER_EXISTS"
  | "PORT_IN_USE"
  | "IMAGE_MISSING"
  | "DEVELOPMENT_VOLUME_IN_USE"
  | "CONTAINER_INSPECT_INVALID"
  | "CONTAINER_INSPECT_MISMATCH"
  | "POST_CHECK_FAILED";

export class TestDbError extends Error {
  readonly code: TestDbErrorCode;

  constructor(code: TestDbErrorCode, detail: string) {
    super(`[testdb] ${code}: ${detail}`);
    this.name = "TestDbError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type TestDbMode = "check" | "status" | "up" | "down";
/** apply が true のときだけ、up・down の変更操作を実行する */
export type TestDbCommand = { mode: TestDbMode; apply: boolean };
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

/** 受け付ける引数の組み合わせ（順番も固定。これ以外はすべて拒否する） */
const ACCEPTED_ARGS: ReadonlyArray<readonly [readonly string[], TestDbCommand]> = [
  [["--check"], { mode: "check", apply: false }],
  [["--status"], { mode: "status", apply: false }],
  [["--up"], { mode: "up", apply: false }],
  [["--up", "--apply"], { mode: "up", apply: true }],
  [["--down"], { mode: "down", apply: false }],
  [["--down", "--apply"], { mode: "down", apply: true }],
];

export function parseTestDbArgs(args: readonly string[]): TestDbCommand {
  for (const [expected, command] of ACCEPTED_ARGS) {
    if (expected.length === args.length && expected.every((value, i) => value === args[i])) return { ...command };
  }
  throw new TestDbError("ARGUMENTS_INVALID", "the only accepted arguments are --check, --status, --up [--apply] or --down [--apply].");
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

/** テストDBのイメージ（verifyComposeConfig で照合した値）。存在しなければ取得せずに止まる */
const TEST_IMAGE = "postgres:15";
const TEST_HOST_IP = "127.0.0.1";
const TEST_HOST_PORT = "5434";
/** up の待ち時間（秒）。healthcheck が通るまで待つ */
const UP_WAIT_TIMEOUT_SECONDS = "120";

/**
 * up のサブコマンド（固定）。対象のサービスを明示し、依存サービス・ビルド・作り直し・イメージの取得をしない。
 * `--remove-orphans`・`--renew-anon-volumes`・`--force-recreate`・`--build` は使わない。
 */
export const UP_SUBCOMMAND = [
  "up",
  "--detach",
  "--wait",
  "--wait-timeout",
  UP_WAIT_TIMEOUT_SECONDS,
  "--no-deps",
  "--no-build",
  "--no-recreate",
  "--pull",
  "never",
  TEST_SERVICE,
] as const;
/** down のサブコマンド（固定）。`--volumes`・`--remove-orphans`・`--rmi` は使わない */
export const DOWN_SUBCOMMAND = ["down"] as const;
/** 変更操作に含まれていてはいけない引数（固定のサブコマンドに対する、念のための再確認） */
const FORBIDDEN_MUTATION_ARGS = [
  "--volumes",
  "-v",
  "--remove-orphans",
  "--rmi",
  "--renew-anon-volumes",
  "-V",
  "--force-recreate",
  "--always-recreate-deps",
  "--build",
  "always",
  "missing",
];

/** 開発用コンテナ katana-db の比較に使う項目（名前・ID・状態）。経過時間を含む .Status は、比較が揺れるので使わない */
const DEVELOPMENT_CONTAINER_FORMAT = "{{.Names}}\t{{.ID}}\t{{.State}}";
/** 名前が katana-test-db のコンテナの、名前と Compose のプロジェクト（別のプロジェクトの同名コンテナを見つける） */
const SAME_NAME_FORMAT = '{{.Names}}\t{{.Label "com.docker.compose.project"}}';
/** テスト用コンテナの inspect で読む項目だけを、JSON の形で取り出す（Config.Env などのパスワードを含む項目は読まない） */
export const CONTAINER_INSPECT_FORMAT =
  '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},' +
  '"service":{{json (index .Config.Labels "com.docker.compose.service")}},' +
  '"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},' +
  '"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},' +
  '"state":{{json .State.Status}},' +
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},' +
  '"mounts":{{json .Mounts}},' +
  '"tmpfs":{{json .HostConfig.Tmpfs}},' +
  '"ports":{{json .HostConfig.PortBindings}}}';
const INSPECT_ARGS = ["inspect", "--type", "container", TEST_CONTAINER, "--format", CONTAINER_INSPECT_FORMAT];
const IMAGE_ARGS = ["image", "inspect", TEST_IMAGE, "--format", "{{.Id}}"];

const sameArgs = (expected: readonly string[], args: readonly string[]) =>
  expected.length === args.length && expected.every((value, i) => value === args[i]);

/** 実行してよい Docker のコマンド（すべて読み取り専用） */
function isReadOnlyDockerCommand(root: string, args: readonly string[]): boolean {
  return [
    ["context", "show"],
    composeArgs(root, ["config", "--quiet"]),
    composeArgs(root, ["config", "--format", "json"]),
    composeArgs(root, ["ps", "--all", "--format", "json"]),
    ["ps", "--all", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Names}}"],
    ["ps", "--all", "--filter", `name=^${TEST_CONTAINER}$`, "--format", SAME_NAME_FORMAT],
    ["ps", "--all", "--filter", "name=^katana-db$", "--format", DEVELOPMENT_CONTAINER_FORMAT],
    ["ps", "--all", "--filter", `volume=${DEVELOPMENT_VOLUME}`, "--format", "{{.Names}}"],
    ["ps", "--all", "--filter", `publish=${TEST_HOST_PORT}`, "--format", "{{.Names}}"],
    ["volume", "ls", "--format", "{{.Name}}"],
    ["volume", "ls", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Name}}"],
    ["volume", "inspect", DEVELOPMENT_VOLUME, "--format", DEVELOPMENT_VOLUME_FORMAT],
    IMAGE_ARGS,
    INSPECT_ARGS,
  ].some((expected) => sameArgs(expected, args));
}

/** 実行してよい変更操作（up・down の2つだけ）。どちらも katana-test プロジェクトの固定の引数 */
export function isAllowedMutation(root: string, args: readonly string[]): boolean {
  if (args.some((arg) => FORBIDDEN_MUTATION_ARGS.includes(arg))) return false;
  return [composeArgs(root, UP_SUBCOMMAND), composeArgs(root, DOWN_SUBCOMMAND)].some((expected) => sameArgs(expected, args));
}

/** 表示する前に、パスワードと接続URLを伏せる */
function redact(text: string, verified: VerifiedTestDbEnv): string {
  let result = text;
  for (const secret of [verified.databaseUrl, verified.appPassword, verified.adminPassword]) result = result.split(secret).join("(hidden)");
  return result.replace(/postgres(ql)?:\/\/\S+/g, "(hidden)");
}

type Docker = {
  /** 読み取り専用のコマンド。終了コードが0でなければ止まる */
  read: (args: readonly string[]) => Promise<string>;
  /** 読み取り専用のコマンドを実行し、成功したかだけを返す（イメージの有無の確認に使う） */
  probe: (args: readonly string[]) => Promise<boolean>;
  /** 変更操作（up・down）。apply が true で、固定の引数と完全に一致するときだけ実行する */
  mutate: (args: readonly string[]) => Promise<void>;
};

function makeDocker(deps: TestDbDeps, childEnv: Record<string, string>, verified: VerifiedTestDbEnv, apply: boolean): Docker {
  const options: RunOptions = { cwd: deps.root, env: childEnv, shell: false };
  const failed = (args: readonly string[], result: CommandResult) => {
    const stderr = redact(result.stderr.trim(), verified).slice(0, 500);
    return new TestDbError("DOCKER_COMMAND_FAILED", `docker ${args.includes("compose") ? "compose" : args[0]} exited with ${result.code}${stderr ? `: ${stderr}` : ""}`);
  };
  const assertReadOnly = (args: readonly string[]) => {
    if (!isReadOnlyDockerCommand(deps.root, args)) {
      throw new TestDbError("DOCKER_COMMAND_NOT_ALLOWED", "only read-only docker commands are allowed.");
    }
  };
  return {
    read: async (args) => {
      assertReadOnly(args);
      const result = await deps.run("docker", args, options);
      if (result.code !== 0) throw failed(args, result);
      return result.stdout;
    },
    probe: async (args) => {
      assertReadOnly(args);
      return (await deps.run("docker", args, options)).code === 0;
    },
    mutate: async (args) => {
      if (!apply) throw new TestDbError("MUTATION_NOT_ALLOWED", "changing operations require --apply.");
      if (!isAllowedMutation(deps.root, args)) {
        throw new TestDbError("DOCKER_COMMAND_NOT_ALLOWED", "only the fixed up and down commands of the katana-test project are allowed.");
      }
      const result = await deps.run("docker", args, options);
      if (result.code !== 0) throw failed(args, result);
    },
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
const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

/** コンテナの一覧の1件（`docker compose ps --format json` から、使う項目だけ） */
export type ComposeContainer = { name: string; service: string; state: string; health: string };

/** 操作の前後に比べる Docker の状態（読み取り専用のコマンドだけで集める）。パスワードを含む項目は読まない */
export type DockerSnapshot = {
  /** katana-test プロジェクトのコンテナ（docker compose ps） */
  projectContainers: ComposeContainer[];
  /** ラベル com.docker.compose.project=katana-test のコンテナの名前 */
  labeledContainers: string[];
  /** 名前が katana-test-db のコンテナ（名前とプロジェクトのラベル） */
  sameNameContainers: string[];
  /** ラベル com.docker.compose.project=katana-test のボリューム */
  projectVolumes: string[];
  /** すべてのボリュームの名前（名前順。無名のボリュームが増えていないかの比較に使う） */
  volumes: string[];
  /** 5434番を公開しているコンテナの名前 */
  portPublishers: string[];
  /** 開発用コンテナ katana-db（名前・ID・状態）。存在しなければ空 */
  developmentContainer: string[];
  /** 開発用ボリュームの名前・作成日時・ラベル。存在しなければ空 */
  developmentVolume: string[];
  /** 開発用ボリュームを使っているコンテナの名前 */
  developmentVolumeUsers: string[];
};

async function readSnapshot(root: string, docker: Docker): Promise<DockerSnapshot> {
  const projectContainers = parseComposePs(await docker.read(composeArgs(root, ["ps", "--all", "--format", "json"]))).map((c) => ({
    name: String(c?.Name ?? ""),
    service: String(c?.Service ?? ""),
    state: String(c?.State ?? ""),
    health: String(c?.Health ?? ""),
  }));
  const labeledContainers = lines(await docker.read(["ps", "--all", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Names}}"]));
  const sameNameContainers = lines(await docker.read(["ps", "--all", "--filter", `name=^${TEST_CONTAINER}$`, "--format", SAME_NAME_FORMAT]));
  const projectVolumes = lines(await docker.read(["volume", "ls", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`, "--format", "{{.Name}}"]));
  const volumes = lines(await docker.read(["volume", "ls", "--format", "{{.Name}}"])).sort();
  const portPublishers = lines(await docker.read(["ps", "--all", "--filter", `publish=${TEST_HOST_PORT}`, "--format", "{{.Names}}"]));
  const developmentContainer = lines(await docker.read(["ps", "--all", "--filter", "name=^katana-db$", "--format", DEVELOPMENT_CONTAINER_FORMAT]));
  const developmentVolume = volumes.includes(DEVELOPMENT_VOLUME)
    ? lines(await docker.read(["volume", "inspect", DEVELOPMENT_VOLUME, "--format", DEVELOPMENT_VOLUME_FORMAT]))
    : [];
  const developmentVolumeUsers = lines(await docker.read(["ps", "--all", "--filter", `volume=${DEVELOPMENT_VOLUME}`, "--format", "{{.Names}}"]));
  return {
    projectContainers,
    labeledContainers,
    sameNameContainers,
    projectVolumes,
    volumes,
    portPublishers,
    developmentContainer,
    developmentVolume,
    developmentVolumeUsers,
  };
}

/** 開発用DBの記録（コンテナ・ボリューム・ボリュームを使うコンテナ）が同じか */
function sameDevelopmentRecord(a: DockerSnapshot, b: DockerSnapshot): boolean {
  return (
    sameList(a.developmentContainer, b.developmentContainer) &&
    sameList(a.developmentVolume, b.developmentVolume) &&
    sameList(a.developmentVolumeUsers, b.developmentVolumeUsers)
  );
}

/** テストDBのコンテナが（どの一覧にでも）存在するか */
function testContainerExists(snapshot: DockerSnapshot): boolean {
  return snapshot.projectContainers.length > 0 || snapshot.labeledContainers.length > 0 || snapshot.sameNameContainers.length > 0;
}

/**
 * katana-test プロジェクトの中身が、テストDBのコンテナ（あれば）だけであることを確かめる（up・down の前に共通）。
 * 想定外のコンテナ・サービス・ボリューム、同じ名前の別のコンテナ、開発用ボリュームを使うテスト用コンテナがあれば止まる。
 */
export function assertProjectContents(snapshot: DockerSnapshot): void {
  const names = [...snapshot.projectContainers.map((c) => c.name), ...snapshot.labeledContainers];
  if (names.some((name) => name !== TEST_CONTAINER)) {
    throw new TestDbError("UNEXPECTED_CONTAINER", `the ${COMPOSE_PROJECT} project has containers other than ${TEST_CONTAINER}.`);
  }
  if (snapshot.projectContainers.some((c) => c.service !== TEST_SERVICE)) {
    throw new TestDbError("UNEXPECTED_SERVICE", `the ${COMPOSE_PROJECT} project has a service other than ${TEST_SERVICE}.`);
  }
  if (snapshot.sameNameContainers.some((row) => row !== `${TEST_CONTAINER}\t${COMPOSE_PROJECT}`)) {
    throw new TestDbError("CONTAINER_NAME_CONFLICT", `a container named ${TEST_CONTAINER} exists outside the ${COMPOSE_PROJECT} project.`);
  }
  if (snapshot.projectVolumes.length > 0) {
    throw new TestDbError("UNEXPECTED_VOLUME", `the ${COMPOSE_PROJECT} project has volumes; the test database must not use volumes.`);
  }
  if (snapshot.developmentVolumeUsers.includes(TEST_CONTAINER)) {
    throw new TestDbError("DEVELOPMENT_VOLUME_IN_USE", `${TEST_CONTAINER} uses the development volume.`);
  }
}

/** up の前の確認：テストDBのコンテナが1つもなく、5434番を公開しているコンテナもないこと */
export function assertReadyForUp(snapshot: DockerSnapshot): void {
  assertProjectContents(snapshot);
  if (testContainerExists(snapshot)) {
    // 既存のコンテナは、起動し直したり作り直したりしない（--status で状態を確かめ、必要なら --down で片付ける）
    throw new TestDbError("TEST_CONTAINER_EXISTS", `${TEST_CONTAINER} already exists; check it with --status and remove it with --down first.`);
  }
  if (snapshot.portPublishers.length > 0) {
    throw new TestDbError("PORT_IN_USE", `a container already publishes port ${TEST_HOST_PORT}.`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- docker inspect の JSON を、形を確かめながら読む */
/**
 * テスト用コンテナの inspect（CONTAINER_INSPECT_FORMAT）を照合し、不一致の項目名を返す（値は含めない）。
 * Compose のラベル（プロジェクト・サービス・Composeファイル・作業ディレクトリ）で、このラッパーが作ったコンテナであることを確かめる。
 * running が true なら（up の後）、起動していて healthy であることも確かめる。false なら（down の前）、状態は問わない
 * （起動途中・unhealthy・停止済みでも、同一性を確かめられれば down できる）。
 */
export function containerInspectMismatches(json: string, root: string, options: { running: boolean }): string[] {
  let c: any;
  try {
    c = JSON.parse(json);
  } catch {
    throw new TestDbError("CONTAINER_INSPECT_INVALID", "docker inspect did not return JSON.");
  }
  const mismatches: string[] = [];
  const expect = (name: string, ok: boolean) => {
    if (!ok) mismatches.push(name);
  };
  expect("project label", c?.project === COMPOSE_PROJECT);
  expect("service label", c?.service === TEST_SERVICE);
  expect("compose file label", c?.configFiles === path.join(root, COMPOSE_FILE));
  expect("working directory label", c?.workingDir === root);
  const mounts = Array.isArray(c?.mounts) ? c.mounts : [];
  expect("no volume mounts", mounts.every((m: any) => m?.Type !== "volume"));
  expect(
    "mounts",
    mounts.length === 1 &&
      mounts[0].Type === "bind" &&
      mounts[0].Source === path.join(root, INIT_DIR) &&
      mounts[0].Destination === INIT_TARGET &&
      mounts[0].RW === false,
  );
  expect("tmpfs", c?.tmpfs !== null && typeof c?.tmpfs === "object" && Object.keys(c.tmpfs).includes(DATA_DIR));
  const ports = c?.ports !== null && typeof c?.ports === "object" ? c.ports : {};
  const bindings = Array.isArray(ports["5432/tcp"]) ? ports["5432/tcp"] : [];
  expect(
    "ports",
    JSON.stringify(Object.keys(ports)) === JSON.stringify(["5432/tcp"]) &&
      bindings.length === 1 &&
      bindings[0].HostIp === TEST_HOST_IP &&
      bindings[0].HostPort === TEST_HOST_PORT,
  );
  if (options.running) {
    expect("state", c?.state === "running");
    expect("health", c?.health === "healthy");
  }
  return mismatches;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** up の後の確認。不一致の項目名を返す（値は含めない） */
export function upPostCheckMismatches(before: DockerSnapshot, after: DockerSnapshot, inspectMismatches: readonly string[]): string[] {
  const mismatches: string[] = [];
  const c = after.projectContainers;
  if (!(c.length === 1 && c[0].name === TEST_CONTAINER && c[0].service === TEST_SERVICE)) mismatches.push("project containers");
  if (!(c.length === 1 && c[0].state === "running" && c[0].health === "healthy")) mismatches.push("container state");
  if (!sameList(after.labeledContainers, [TEST_CONTAINER])) mismatches.push("labeled containers");
  if (!sameList(after.sameNameContainers, [`${TEST_CONTAINER}\t${COMPOSE_PROJECT}`])) mismatches.push("container name");
  if (after.projectVolumes.length > 0) mismatches.push("project volumes");
  // R7：無名のボリュームを含め、ボリュームが1つも増減していないこと
  if (!sameList(before.volumes, after.volumes)) mismatches.push("volumes (an anonymous volume may have been created)");
  if (!sameList(after.portPublishers, [TEST_CONTAINER])) mismatches.push("port publishers");
  if (!sameDevelopmentRecord(before, after)) mismatches.push("development database record");
  return [...mismatches, ...inspectMismatches.map((name) => `inspect: ${name}`)];
}

/** down の後の確認。不一致の項目名を返す（値は含めない） */
export function downPostCheckMismatches(before: DockerSnapshot, after: DockerSnapshot): string[] {
  const mismatches: string[] = [];
  if (testContainerExists(after)) mismatches.push("test container still exists");
  if (after.projectVolumes.length > 0) mismatches.push("project volumes");
  if (!sameList(before.volumes, after.volumes)) mismatches.push("volumes");
  if (!sameDevelopmentRecord(before, after)) mismatches.push("development database record");
  return mismatches;
}

function describeSnapshot(snapshot: DockerSnapshot): string[] {
  const containers = snapshot.projectContainers;
  const list = (values: readonly string[], empty: string) => (values.length === 0 ? empty : values.join(", "));
  return [
    `${COMPOSE_PROJECT} containers: ${containers.length === 0 ? "none" : containers.map((c) => `${c.name} (${c.state || "unknown"}${c.health ? `, ${c.health}` : ""})`).join(", ")}`,
    `${COMPOSE_PROJECT} volumes: ${list(snapshot.projectVolumes, "none")}`,
    `containers publishing port ${TEST_HOST_PORT}: ${list(snapshot.portPublishers, "none")}`,
    `development container katana-db (name, id, state): ${list(snapshot.developmentContainer, "not present")}`,
    `development volume (name, created, compose project, compose volume): ${list(snapshot.developmentVolume, "not present")}`,
    `containers using the development volume: ${list(snapshot.developmentVolumeUsers, "none")}`,
    `all volumes: ${snapshot.volumes.length}`,
  ];
}

/** 手順どおりに検証し、成功したら0を返す。失敗したら TestDbError を投げる */
export async function runTestDb(deps: TestDbDeps): Promise<number> {
  const { root } = deps;

  // 1. 引数  2. Node の起動オプション  3. Docker の接続先を変える変数
  const { mode, apply } = parseTestDbArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new TestDbError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running this script.");
  }
  const dockerTarget = DOCKER_TARGET_ENV.filter((key) => deps.parentEnv[key] !== undefined);
  if (dockerTarget.length > 0) {
    throw new TestDbError("DOCKER_TARGET_ENV_PRESENT", `unset ${dockerTarget.join(", ")} before running this script.`);
  }

  // 4. .env.test・.env  5. 検証（接続先と、R14のパスワード）  6. 子プロセスの環境変数（R15）
  const verified = verifyTestDbEnv(deps.readEnvFile(path.join(root, TEST_ENV_FILE)), deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE)));
  const { childEnv, droppedKeys } = buildComposeEnv(deps.parentEnv, verified);

  // 7. ファイル
  for (const relative of [COMPOSE_FILE, INIT_DIR, ...INIT_FILES]) {
    if (!deps.pathExists(path.join(root, relative))) throw new TestDbError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }

  // 8. Docker のコンテキスト（ファイルを読むだけで、デーモンには接続しない）
  const docker = makeDocker(deps, childEnv, verified, apply);
  const context = (await docker.read(["context", "show"])).trim();
  if (context !== EXPECTED_DOCKER_CONTEXT) {
    throw new TestDbError("DOCKER_CONTEXT_MISMATCH", `the docker context is not ${EXPECTED_DOCKER_CONTEXT}.`);
  }

  // 9. Compose の構成（変数展開を含む）。出力は表示せず、プログラムの中で照合する（サービスが test-db の1つだけであることも確かめる）
  await docker.read(composeArgs(root, ["config", "--quiet"]));
  const summary = verifyComposeConfig(await docker.read(composeArgs(root, ["config", "--format", "json"])), root, verified);

  const details = [
    "",
    `connection target: verified ${verified.target.host}:${verified.target.port}/${verified.target.database} as ${verified.target.user} (password hidden)`,
    `passwords: ${TEST_ENV_FILE} values verified (not placeholders, allowed characters, URL password matches, admin differs)`,
    `docker context: ${context}`,
    `child environment: ${Object.keys(childEnv).sort().join(", ")} (password values hidden); dropped ${droppedKeys.length} variable(s) from the parent`,
    "",
    "docker compose config:",
    ...summary.map((line) => `  ${line}`),
  ];
  const untouched = "no container was created, started, stopped or removed, and no database connection was made.";
  if (mode === "check") {
    deps.log([`[testdb] check mode: ${untouched}`, ...details].join("\n"));
    return 0;
  }

  // 10. katana-test プロジェクトの状態  11. 開発用DBの記録（どちらも読み取りだけ）
  const before = await readSnapshot(root, docker);

  if (mode === "status") {
    const names = [...before.projectContainers.map((c) => c.name), ...before.labeledContainers];
    if (names.some((name) => name !== TEST_CONTAINER)) {
      throw new TestDbError("STATUS_UNEXPECTED_CONTAINER", `the ${COMPOSE_PROJECT} project has containers other than ${TEST_CONTAINER}.`);
    }
    deps.log([`[testdb] status mode: ${untouched}`, ...details, "", ...describeSnapshot(before)].join("\n"));
    return 0;
  }

  if (mode === "up") {
    assertReadyForUp(before);
    // イメージは取得しない（--pull never）。なければ止まる
    if (!(await docker.probe(IMAGE_ARGS))) {
      throw new TestDbError("IMAGE_MISSING", `the image ${TEST_IMAGE} is not present locally; this script does not pull images.`);
    }
    const upArgs = composeArgs(root, UP_SUBCOMMAND);
    if (!apply) {
      deps.log(
        [
          `[testdb] up mode (dry run; --apply was not given): ${untouched}`,
          ...details,
          "",
          ...describeSnapshot(before),
          "",
          `would run: docker compose (fixed project, file, directory and env file) ${UP_SUBCOMMAND.join(" ")} (no shell)`,
        ].join("\n"),
      );
      return 0;
    }

    await docker.mutate(upArgs);
    // 起動後の確認。失敗しても、コンテナ・ボリュームは削除しない
    const after = await readSnapshot(root, docker);
    const inspect = containerInspectMismatches(await docker.read(INSPECT_ARGS), root, { running: true });
    const mismatches = upPostCheckMismatches(before, after, inspect);
    if (mismatches.length > 0) {
      throw new TestDbError(
        "POST_CHECK_FAILED",
        `the check after up failed: ${mismatches.join(", ")}. Nothing was removed; inspect the state with --status before doing anything else.`,
      );
    }
    deps.log(
      [
        `[testdb] up: ${TEST_CONTAINER} was created and started. This script made no database connection.`,
        ...details,
        "",
        ...describeSnapshot(after),
        "",
        "post-up checks: passed (only the read-only init bind mount, tmpfs data directory, port 127.0.0.1:5434 only, healthy, no new volumes, development record unchanged)",
      ].join("\n"),
    );
    return 0;
  }

  // mode === "down"
  assertProjectContents(before);
  if (!testContainerExists(before)) {
    deps.log([`[testdb] down mode: there is no ${TEST_CONTAINER} container, so there is nothing to do. ${untouched}`, ...details, "", ...describeSnapshot(before)].join("\n"));
    return 0;
  }
  const inspect = containerInspectMismatches(await docker.read(INSPECT_ARGS), root, { running: false });
  if (inspect.length > 0) {
    throw new TestDbError("CONTAINER_INSPECT_MISMATCH", `${TEST_CONTAINER} does not match the expected test database container: ${inspect.join(", ")}.`);
  }
  const downArgs = composeArgs(root, DOWN_SUBCOMMAND);
  if (!apply) {
    deps.log(
      [
        `[testdb] down mode (dry run; --apply was not given): ${untouched}`,
        ...details,
        "",
        ...describeSnapshot(before),
        "",
        `would run: docker compose (fixed project, file, directory and env file) ${DOWN_SUBCOMMAND.join(" ")} (no shell; no --volumes, --remove-orphans or --rmi)`,
        "with --apply, the test data on tmpfs will be lost.",
      ].join("\n"),
    );
    return 0;
  }

  await docker.mutate(downArgs);
  // 停止後の確認。失敗しても、コンテナ・ボリュームを作り直さない
  const after = await readSnapshot(root, docker);
  const mismatches = downPostCheckMismatches(before, after);
  if (mismatches.length > 0) {
    throw new TestDbError(
      "POST_CHECK_FAILED",
      `the check after down failed: ${mismatches.join(", ")}. Nothing was recreated; inspect the state with --status before doing anything else.`,
    );
  }
  deps.log(
    [
      `[testdb] down: ${TEST_CONTAINER} was stopped and removed (the test data on tmpfs is gone). No volume or image was removed.`,
      ...details,
      "",
      ...describeSnapshot(after),
      "",
      "post-down checks: passed (no test container, no new or removed volumes, development record unchanged)",
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
