import path from "node:path";
import { DB_TARGET_ENV, DB_TARGET_TEST } from "../db/prismaCliGuard.ts";
import {
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import { DEVELOPMENT_ENV_FILE, inheritAllowedEnv, TEST_ENV_FILE } from "./integrationEnv.ts";

/**
 * テストDB専用の migration（scripts/testdb-migrate.mts）の本体。2-7の手順のうち、DBに接続しない部分を担う。
 *
 * 外部とのやりとり（env ファイルの読み込み、ファイルの存在確認、接続後の本人確認、子プロセスの起動、表示）は
 * すべて引数で受け取る。そのため、単体テストでは Prisma CLI を起動せず、DBにも接続せずに検証できる。
 *
 * 実行順序（途中で失敗したら、その時点で止める。別の接続先は試さない）:
 * 1. 引数の検証  2. Node の起動オプション（execArgv・NODE_OPTIONS）の確認  3. `.env.test` の読み込み
 * 4. `.env` の開発用DBの接続先の取得  5. テストDBのURLとパスワード（R14）の検証  6. 子プロセスの環境変数の生成（作った後にもう一度検証）
 * 7. 実行する Prisma CLI のコマンドの確認  （確認モードはここで表示して終了する）
 * 8. 接続後の本人確認（DBのコメントの照合。2-7の4）  9. すべて成功した場合だけ子プロセスを起動する
 *
 * Prisma CLI のコマンドは `migrate deploy` に固定し、外部から引数を渡せない。`migrate deploy` は未適用の migration を
 * 適用するだけで、DBの作り直し・Prisma Client の生成・seed は行わない。
 * 表示・例外のメッセージには、接続URL・パスワードを含めない。
 */

export const PRISMA_CLI_ENTRY = path.join("node_modules", "prisma", "build", "index.js");
export const PRISMA_CONFIG_FILE = "prisma.config.ts";
/** 子プロセスに渡す Prisma CLI のサブコマンド（固定） */
export const PRISMA_MIGRATE_COMMAND = ["migrate", "deploy"] as const;
/** 起動前に存在を確かめるファイル・ディレクトリ */
const REQUIRED_PATHS = [PRISMA_CLI_ENTRY, PRISMA_CONFIG_FILE, path.join("prisma", "schema.prisma"), path.join("prisma", "migrations")];
/** 表示するときに値を伏せる環境変数 */
const HIDDEN_VALUE_KEYS = new Set(["DATABASE_URL"]);
/** 落としたことを名前で表示する環境変数（接続先・読み込みに関わるもの） */
const NOTABLE_DROPPED_KEY = /^(PG|DOTENV_|NODE_|PRISMA_|KATANA_|DATABASE_URL$)/;

export type TestDbMigrateErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "REQUIRED_FILE_MISSING"
  | "IDENTITY_CHECK_NOT_IMPLEMENTED";

export class TestDbMigrateError extends Error {
  readonly code: TestDbMigrateErrorCode;

  constructor(code: TestDbMigrateErrorCode, detail: string) {
    super(`[testdb-migrate] ${code}: ${detail}`);
    this.name = "TestDbMigrateError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type TestDbMigrateMode = "run" | "check";

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  stdio: "inherit";
};

export type TestDbMigrateDeps = {
  /** katana-web/ の絶対パス（子プロセスの作業ディレクトリ） */
  root: string;
  /** スクリプトに渡された引数（process.argv.slice(2)） */
  argv: readonly string[];
  /** process.execArgv */
  execArgv: readonly string[];
  /** 子プロセスで使う Node の実行ファイル（process.execPath） */
  execPath: string;
  parentEnv: EnvSource;
  /** env ファイルを dotenv.parse で読む。ファイルがなければ undefined */
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** 接続後の本人確認（2-7の4）。通常実行モードで、子プロセスの起動直前にだけ呼ぶ */
  verifyDatabaseIdentity: (target: TestDatabaseTarget) => Promise<void>;
  /** 子プロセスを起動し、終了コードを返す */
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => Promise<number>;
  log: (text: string) => void;
};

export function parseTestDbMigrateArgs(args: readonly string[]): TestDbMigrateMode {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "--check") return "check";
  throw new TestDbMigrateError("ARGUMENTS_INVALID", "the only accepted argument is --check.");
}

/** 検証関数を実行し、失敗したらエラーコードだけを含むエラーに置き換える（拒否された値を表示しない） */
function verifyTarget(databaseUrl: string | undefined, env: EnvSource, developmentEnv: EnvSource | undefined): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbMigrateError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    throw error;
  }
}

/**
 * 子プロセスの環境変数を作る。親からは許可リストのものだけを引き継ぎ、DATABASE_URL は検証済みの値だけを設定する。
 * PG*・DOTENV_*・NODE_OPTIONS・親の DATABASE_URL・PRISMA_* などは引き継がない。
 */
export function buildTestDbMigrateEnv(parentEnv: EnvSource, verifiedDatabaseUrl: string): { childEnv: Record<string, string>; droppedKeys: string[] } {
  const { inherited, droppedKeys } = inheritAllowedEnv(parentEnv);
  return { childEnv: { ...inherited, DATABASE_URL: verifiedDatabaseUrl, [DB_TARGET_ENV]: DB_TARGET_TEST }, droppedKeys };
}

function formatCheckReport(input: {
  root: string;
  target: TestDatabaseTarget;
  execPath: string;
  args: readonly string[];
  childEnv: Record<string, string>;
  droppedKeys: string[];
}): string {
  const { root, target, execPath, args, childEnv, droppedKeys } = input;
  return [
    "[testdb-migrate] check mode: the Prisma CLI was not started and no database connection was made.",
    "",
    `connection target: verified ${target.host}:${target.port}/${target.database} as ${target.user} (${TEST_ENV_FILE} DATABASE_URL; password hidden)`,
    `working directory: ${root}`,
    `command: ${path.basename(execPath)} ${args.map((arg) => (path.isAbsolute(arg) ? path.relative(root, arg) : arg)).join(" ")} (no shell)`,
    "pre-migration database identity check: required before the Prisma CLI starts (not run in check mode)",
    "",
    "child environment:",
    ...Object.keys(childEnv)
      .sort()
      .map((key) => `  ${key}=${HIDDEN_VALUE_KEYS.has(key) ? "(hidden)" : childEnv[key]}`),
    "",
    `dropped from the parent environment: ${droppedKeys.length} variable(s)`,
    ...droppedKeys.filter((key) => NOTABLE_DROPPED_KEY.test(key)).map((key) => `  ${key}`),
  ].join("\n");
}

/** 手順どおりに検証し、通常実行モードでは子プロセスの終了コードを、確認モードでは0を返す */
export async function runTestDbMigrate(deps: TestDbMigrateDeps): Promise<number> {
  const { root } = deps;

  // 1. 引数
  const mode = parseTestDbMigrateArgs(deps.argv);

  // 2. --import・--require などで、スクリプトより先にコードが読み込まれていないこと
  if (deps.execArgv.length > 0) {
    throw new TestDbMigrateError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  }
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbMigrateError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the test database migration.");
  }

  // 3. .env.test（親プロセスの DATABASE_URL は使わない）
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) {
    throw new TestDbMigrateError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found; create it before running the test database migration.`);
  }

  // 4. 開発用DBの接続先（比較にだけ使う）
  const developmentEnv = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE));

  // 5. URLの検証（環境変数の検査は、6で作った子プロセスの環境変数に対して行う）と、パスワードの検証（R14）
  const databaseUrl = testEnv.DATABASE_URL;
  verifyTarget(databaseUrl, {}, developmentEnv);
  try {
    assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new TestDbMigrateError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const verifiedUrl = databaseUrl as string;

  // 6. 子プロセスの環境変数。作った後の最終的な値で、もう一度検証する
  const { childEnv, droppedKeys } = buildTestDbMigrateEnv(deps.parentEnv, verifiedUrl);
  const target = verifyTarget(childEnv.DATABASE_URL, childEnv, developmentEnv);

  // 7. コマンド（固定）
  for (const relative of REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(root, relative))) {
      throw new TestDbMigrateError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
    }
  }
  const args = [path.join(root, PRISMA_CLI_ENTRY), ...PRISMA_MIGRATE_COMMAND, "--config", path.join(root, PRISMA_CONFIG_FILE)];

  if (mode === "check") {
    deps.log(formatCheckReport({ root, target, execPath: deps.execPath, args, childEnv, droppedKeys }));
    return 0;
  }

  // 8. 接続後の本人確認（失敗したら throw され、9 には進まない）
  await deps.verifyDatabaseIdentity(target);

  // 9. 子プロセス
  return deps.spawn(deps.execPath, args, { cwd: root, env: childEnv, shell: false, stdio: "inherit" });
}
