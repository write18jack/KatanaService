import { createHash } from "node:crypto";
import path from "node:path";
import { isInheritedEnvKey } from "../testing/integrationEnv.ts";
import {
  assertReadOnlyTestDatabaseCredentials,
  assertReadOnlyTestDatabaseTarget,
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  ReadOnlyTestDatabaseCredentialsError,
  type ReadOnlyTestDatabaseCredentialsErrorCode,
  TEST_DATABASE_TARGET,
  TEST_DB_RO_URL_KEY,
  TestDatabaseCredentialsError,
  type TestDatabaseCredentialsErrorCode,
  TestDatabaseGuardError,
  type TestDatabaseGuardErrorCode,
} from "./testDatabaseGuard.ts";

/**
 * prisma.config.ts から呼ぶ、Prisma CLI の接続先ガード（2-7）。DBには接続しない。
 *
 * - `KATANA_DB_TARGET` が未設定：開発・本番用の従来の動作。`{ mode: "default" }` を返し、呼び出し側は今までどおり
 *   `env("DATABASE_URL")` を使う。`.env.test`・`.env` は読まない。ただし DATABASE_URL がテストDBらしい場合は拒否する
 *   （テストモードを付け忘れたまま、テストDBに対して CLI を実行させない）。
 * - `KATANA_DB_TARGET=test`：テストDBモード。`.env.test` の DATABASE_URL を assertTestDatabaseTarget() で検証し、
 *   プロセスの DATABASE_URL（scripts/testdb-migrate.mts が検証済みの値を渡す）と完全に一致した場合だけ、
 *   `{ mode: "test", url }` を返す。テストDBモードで別の接続先に切り替える経路は持たない。
 *   `.env.test` のパスワード（見本の値でないこと、URLとの一致など。R14）も、assertTestDatabaseCredentials() で確かめる。
 *   `import "dotenv/config"` が `.env` の開発用URLを補っていた場合は一致しないので、拒否される。
 * - それ以外の値（`TEST`・空文字など）：拒否する（打ち間違いで開発用DBに接続させない）。
 *
 * prisma.config.ts を c12/jiti で読み込む Prisma CLI は、ここで投げた例外を `Error: ${error}` の形で表示して終了する。
 * そのため、エラーメッセージには接続URL・パスワード・拒否した値を含めず、コードだけを含める。
 * runner・lib/prisma.ts と同じく、`.env`・`.env.test` の場所は作業ディレクトリ（katana-web/）を前提にする。
 */

export const DB_TARGET_ENV = "KATANA_DB_TARGET";
export const DB_TARGET_TEST = "test";

export type PrismaCliGuardErrorCode =
  | "TARGET_INVALID"
  | "TEST_URL_WITHOUT_TEST_TARGET"
  | "NODE_OPTIONS_PRESENT"
  | "DOTENV_ARGUMENT_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "DATABASE_URL_MISMATCH"
  // 以下は schemaDiff 用（resolvePrismaCliReadOnlyTarget）だけ
  | "COMMAND_MISMATCH"
  | "ENV_NOT_ALLOWED"
  | "ENV_NOT_FIXED"
  | "READ_ONLY_ENV_MISSING"
  | "READ_ONLY_TARGET_REJECTED"
  | "READ_ONLY_CREDENTIALS_REJECTED"
  | "READ_ONLY_URL_MISMATCH";

type GuardTargetCode = TestDatabaseGuardErrorCode | TestDatabaseCredentialsErrorCode | ReadOnlyTestDatabaseCredentialsErrorCode;

export class PrismaCliGuardError extends Error {
  readonly code: PrismaCliGuardErrorCode;
  /**
   * TARGET_REJECTED・READ_ONLY_TARGET_REJECTED のときは assertTestDatabaseTarget()・assertReadOnlyTestDatabaseTarget() の、
   * CREDENTIALS_REJECTED・READ_ONLY_CREDENTIALS_REJECTED のときは assertTestDatabaseCredentials()・assertReadOnlyTestDatabaseCredentials() のエラーコード
   */
  readonly targetCode?: GuardTargetCode;

  constructor(code: PrismaCliGuardErrorCode, detail: string, targetCode?: GuardTargetCode) {
    super(`[prismaCliGuard] ${code}: ${detail}`);
    this.name = "PrismaCliGuardError";
    this.code = code;
    this.targetCode = targetCode;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export type PrismaCliGuardInput = {
  /** `import "dotenv/config"` を実行した後の process.env */
  env: EnvSource;
  /** process.argv（dotenv/config が読む `dotenv_config_*=` の引数を検査する） */
  argv: readonly string[];
  /** `.env.test` を dotenv.parse した結果。ファイルがなければ undefined。テストDBモードでだけ呼ぶ */
  readTestEnv: () => EnvSource | undefined;
  /** `.env` を dotenv.parse した結果。ファイルがなければ undefined。テストDBモードでだけ呼ぶ */
  readDevelopmentEnv: () => EnvSource | undefined;
};

/** dotenv/config が process.argv から読む設定（読み込み先・上書きを変えられる） */
const DOTENV_ARGUMENT = /^dotenv_config_/i;

/** テストDBを指しているらしいURLか（DB名・ユーザーのどちらか、またはループバックの5434番ポート）。解析できなければ false */
function looksLikeTestDatabase(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = (TEST_DATABASE_TARGET.hosts as readonly string[]).includes(url.hostname);
  return (
    url.pathname === `/${TEST_DATABASE_TARGET.database}` ||
    url.username === TEST_DATABASE_TARGET.user ||
    (loopback && url.port === TEST_DATABASE_TARGET.port)
  );
}

export type PrismaCliDatabaseTarget = { mode: "default" } | { mode: "test"; url: string };

/**
 * Prisma CLI の接続先を決める。テストDBモードでなければ `{ mode: "default" }`（従来どおり env("DATABASE_URL") を使う）。
 * 条件を満たさなければ PrismaCliGuardError を投げる。
 */
export function resolvePrismaCliDatabaseTarget(input: PrismaCliGuardInput): PrismaCliDatabaseTarget {
  const { env, argv } = input;
  const target = env[DB_TARGET_ENV];

  if (target === undefined) {
    if (looksLikeTestDatabase(env.DATABASE_URL)) {
      throw new PrismaCliGuardError(
        "TEST_URL_WITHOUT_TEST_TARGET",
        `DATABASE_URL looks like the test database, but ${DB_TARGET_ENV}=${DB_TARGET_TEST} is not set; use npm run testdb:migrate.`,
      );
    }
    return { mode: "default" };
  }
  if (target !== DB_TARGET_TEST) {
    throw new PrismaCliGuardError("TARGET_INVALID", `${DB_TARGET_ENV} must be unset or exactly "${DB_TARGET_TEST}".`);
  }

  // ここからテストDBモード。接続先の決定に影響し得るものを先に拒否する
  if (env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== "") {
    throw new PrismaCliGuardError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS must not be set in test database mode.");
  }
  if (argv.some((arg) => DOTENV_ARGUMENT.test(arg))) {
    throw new PrismaCliGuardError("DOTENV_ARGUMENT_PRESENT", "dotenv_config_* arguments are not allowed in test database mode.");
  }

  const testEnv = input.readTestEnv();
  if (testEnv === undefined) {
    throw new PrismaCliGuardError("TEST_ENV_MISSING", ".env.test was not found.");
  }
  const testDatabaseUrl = testEnv.DATABASE_URL;
  if (testDatabaseUrl === undefined || testDatabaseUrl === "") {
    throw new PrismaCliGuardError("TARGET_REJECTED", "the test database target was rejected (URL_MISSING).", "URL_MISSING");
  }

  try {
    // PG*・DOTENV_* は、dotenv/config の読み込み後の最終的な環境変数で検査する
    assertTestDatabaseTarget({ databaseUrl: testDatabaseUrl, env, developmentDatabaseUrl: input.readDevelopmentEnv()?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new PrismaCliGuardError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`, error.code);
    }
    throw error;
  }
  try {
    assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new PrismaCliGuardError("CREDENTIALS_REJECTED", `the test database credentials in .env.test were rejected (${error.code}).`, error.code);
    }
    throw error;
  }

  // .env の開発用URLを流用させない。プロセスの値は、検証済みの .env.test の値と同じでなければならない
  if (env.DATABASE_URL !== testDatabaseUrl) {
    throw new PrismaCliGuardError("DATABASE_URL_MISMATCH", "DATABASE_URL does not match the verified .env.test value.");
  }
  return { mode: "test", url: testDatabaseUrl };
}

// ---- schemaDiff 用（Step 3-12B-5E-9A-9-2。prisma.schemadiff.config.ts から呼ぶ） ----
//
// 方式A（9-1 で決定）：Prisma CLI の `migrate diff` を、katana_test_ro（SELECT だけのロール）の接続URLで実行する。
// 既存の prisma.config.ts・resolvePrismaCliDatabaseTarget（開発用・migration 用の経路）は変えない。
// KATANA_DB_TARGET=test-readonly は、既存の prisma.config.ts では TARGET_INVALID として拒否される（取り違えても接続しない）。
//
// **残余リスク（解消していない）**：Prisma CLI は、設定ファイルの datasource.url を schema engine の起動引数
// `--datasource <JSON>` にそのまま渡す。katana_test_ro のパスワードを含む URL は、engine のプロセス引数に出る。
// これは、ローカルの専用テストDBと最小権限の katana_test_ro に限った残余リスクとして受け入れたもの（9-1）で、ここでは防げない。
// URL は CLI・engine の環境変数には入れない（runner は URL の SHA-256 だけを渡し、この設定ファイルが `.env.test.readonly` から読み直して照合する）。

/** schemaDiff 用の Prisma CLI の接続先モード */
export const DB_TARGET_TEST_READ_ONLY = "test-readonly";
/** runner が渡す、検証済みの katana_test_ro の接続URLの SHA-256（16進数の小文字）。URL そのものは環境変数に入れない */
export const SCHEMA_DIFF_RO_URL_SHA256_ENV = "KATANA_SCHEMA_DIFF_RO_URL_SHA256";
/** schemaDiff 専用の Prisma の設定ファイル（katana-web/ の直下）。dotenv/config を読み込まない */
export const SCHEMA_DIFF_CONFIG_FILE = "prisma.schemadiff.config.ts";
/** katana_test_ro の認証情報のファイル（lib/testing/testDbReadOnlyRole.ts の READ_ONLY_ROLE_ENV_FILE と同じ値。テストで一致を確かめる） */
export const READ_ONLY_TEST_ENV_FILE = ".env.test.readonly";
/** Prisma CLI のエントリ（lib/testing/testDbMigrate.ts の PRISMA_CLI_ENTRY と同じ値。テストで一致を確かめる） */
export const SCHEMA_DIFF_CLI_ENTRY = path.join("node_modules", "prisma", "build", "index.js");
export const SCHEMA_DIFF_SCHEMA_FILE = path.join("prisma", "schema.prisma");

/**
 * Prisma CLI・schema engine の子プロセスに固定で渡す環境変数（runner が設定し、設定ファイルが一致を確かめる）。
 * - CHECKPOINT_DISABLE=1：Prisma のテレメトリ・更新確認（checkpoint.prisma.io）への送信を止める。
 * - CI=1：対話的な確認（panic の報告など）を出さない。
 * - RUST_LOG=error：engine は RUST_LOG を tracing の EnvFilter で読み、標準エラーに JSON のログを出す。CLI はその message を
 *   すべて集め、engine のエラー時に表示する。info 以下を出さないことで、表示され得る内容を減らす（debug では SQL と値が出る）。
 *   EnvFilter は、無効な値でも ERROR だけを出す既定に戻る。CLI の既定値（info）は、子プロセスの環境変数で上書きされる。
 * - RUST_BACKTRACE=0：panic のときのバックトレースを出さない（出力を減らすため。秘密情報の有無とは無関係）。
 */
export const SCHEMA_DIFF_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  CHECKPOINT_DISABLE: "1",
  CI: "1",
  RUST_LOG: "error",
  RUST_BACKTRACE: "0",
});

/** schemaDiff の固定のコマンド（node の後ろの引数。パスは root からの絶対パス）。runner と設定ファイルが、同じ関数で照合する */
export function buildSchemaDiffCliArgs(root: string): readonly string[] {
  return Object.freeze([
    path.join(root, SCHEMA_DIFF_CLI_ENTRY),
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    path.join(root, SCHEMA_DIFF_SCHEMA_FILE),
    "--exit-code",
    "--config",
    path.join(root, SCHEMA_DIFF_CONFIG_FILE),
  ]);
}

/** 接続URLの SHA-256（16進数の小文字） */
export function schemaDiffUrlSha256(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/** CLI のプロセスに許す環境変数の名前（runner の許可リスト・固定の値・接続先モード・URL の SHA-256 だけ） */
function isAllowedSchemaDiffEnvKey(key: string): boolean {
  return isInheritedEnvKey(key) || Object.hasOwn(SCHEMA_DIFF_FIXED_ENV, key) || key === DB_TARGET_ENV || key === SCHEMA_DIFF_RO_URL_SHA256_ENV;
}

export type PrismaCliReadOnlyGuardInput = {
  /** 設定ファイルを読み込んだ Prisma CLI のプロセスの process.env（この設定ファイルは dotenv/config を読み込まない） */
  env: EnvSource;
  /** process.argv（[node, CLI のエントリ, ...引数]） */
  argv: readonly string[];
  /** process.cwd()（runner は katana-web/ を作業ディレクトリにして起動する） */
  cwd: string;
  readTestEnv: () => EnvSource | undefined;
  readReadOnlyEnv: () => EnvSource | undefined;
  readDevelopmentEnv: () => EnvSource | undefined;
};

/**
 * schemaDiff 用の Prisma CLI の接続先を決める（prisma.schemadiff.config.ts から、モジュールの読み込み時に呼ぶ）。DB には接続しない。
 * 条件を1つでも満たさなければ PrismaCliGuardError を投げる（CLI は接続せずに終了する）。メッセージには URL・パスワード・値を含めない。
 *
 * 1. KATANA_DB_TARGET が test-readonly  2. NODE_OPTIONS がない  3. argv が固定の migrate diff のコマンドと完全に一致する
 * 4. 環境変数の名前が許可リストだけで、固定の値（CHECKPOINT_DISABLE など）が一致する（DATABASE_URL・PRISMA_*・DEBUG・PG* などは拒否）
 * 5. `.env.test` を検証する（katana_test_ro のパスワードの使い回しの検査に使う。接続には使わない）
 * 6. `.env.test.readonly` を検証する（katana_test_ro・ループバック・5434・katana_test・クエリなし・開発用DBと別・PG*・DOTENV_* なし）
 * 7. その URL の SHA-256 が、runner の渡した値と一致する（runner が検証したものと同じ URL だけを使う）
 */
export function resolvePrismaCliReadOnlyTarget(input: PrismaCliReadOnlyGuardInput): { mode: "test-readonly"; url: string } {
  const { env, argv } = input;
  if (env[DB_TARGET_ENV] !== DB_TARGET_TEST_READ_ONLY) {
    throw new PrismaCliGuardError("TARGET_INVALID", `${DB_TARGET_ENV} must be exactly "${DB_TARGET_TEST_READ_ONLY}" for this config file.`);
  }
  if (env.NODE_OPTIONS !== undefined) {
    throw new PrismaCliGuardError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS must not be set for the schema diff.");
  }
  const expected = buildSchemaDiffCliArgs(input.cwd);
  const actual = argv.slice(1);
  if (actual.length !== expected.length || actual.some((arg, i) => arg !== expected[i])) {
    throw new PrismaCliGuardError("COMMAND_MISMATCH", "this config file may only be used by the fixed migrate diff command of the schema diff runner.");
  }
  const keys = Object.keys(env).filter((key) => env[key] !== undefined);
  const notAllowed = keys.filter((key) => !isAllowedSchemaDiffEnvKey(key));
  if (notAllowed.length > 0) {
    // 名前は秘密情報ではないので表示する（値は表示しない）
    throw new PrismaCliGuardError("ENV_NOT_ALLOWED", `environment variables outside the allowlist are set: ${notAllowed.sort().join(", ")}.`);
  }
  const notFixed = Object.entries(SCHEMA_DIFF_FIXED_ENV).filter(([key, value]) => env[key] !== value).map(([key]) => key);
  if (notFixed.length > 0) {
    throw new PrismaCliGuardError("ENV_NOT_FIXED", `these variables must have their fixed values: ${notFixed.sort().join(", ")}.`);
  }

  const developmentDatabaseUrl = input.readDevelopmentEnv()?.DATABASE_URL;
  const testEnv = input.readTestEnv();
  if (testEnv === undefined) throw new PrismaCliGuardError("TEST_ENV_MISSING", ".env.test was not found.");
  let app: { appPassword: string; adminPassword: string };
  try {
    assertTestDatabaseTarget({ databaseUrl: testEnv.DATABASE_URL, env: {}, developmentDatabaseUrl });
    app = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new PrismaCliGuardError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`, error.code);
    if (error instanceof TestDatabaseCredentialsError) {
      throw new PrismaCliGuardError("CREDENTIALS_REJECTED", `the test database credentials in .env.test were rejected (${error.code}).`, error.code);
    }
    throw error;
  }

  const readOnlyEnv = input.readReadOnlyEnv();
  if (readOnlyEnv === undefined) throw new PrismaCliGuardError("READ_ONLY_ENV_MISSING", `${READ_ONLY_TEST_ENV_FILE} was not found.`);
  let url: string;
  try {
    // PG*・DOTENV_* は、CLI のプロセスの最終的な環境変数で検査する
    assertReadOnlyTestDatabaseTarget({ databaseUrl: readOnlyEnv[TEST_DB_RO_URL_KEY], env, developmentDatabaseUrl });
    url = assertReadOnlyTestDatabaseCredentials(readOnlyEnv, { databaseUrl: testEnv.DATABASE_URL as string, ...app }).databaseUrl;
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new PrismaCliGuardError("READ_ONLY_TARGET_REJECTED", `the read-only target in ${READ_ONLY_TEST_ENV_FILE} was rejected (${error.code}).`, error.code);
    }
    if (error instanceof ReadOnlyTestDatabaseCredentialsError) {
      throw new PrismaCliGuardError("READ_ONLY_CREDENTIALS_REJECTED", `the read-only credentials in ${READ_ONLY_TEST_ENV_FILE} were rejected (${error.code}).`, error.code);
    }
    throw error;
  }
  const expectedHash = env[SCHEMA_DIFF_RO_URL_SHA256_ENV];
  if (expectedHash === undefined || !/^[0-9a-f]{64}$/.test(expectedHash) || schemaDiffUrlSha256(url) !== expectedHash) {
    throw new PrismaCliGuardError("READ_ONLY_URL_MISMATCH", `the read-only URL does not match the one verified by the schema diff runner.`);
  }
  return { mode: "test-readonly", url };
}
