import { assertTestDatabaseTarget, TEST_DATABASE_TARGET, TestDatabaseGuardError, type TestDatabaseGuardErrorCode } from "./testDatabaseGuard.ts";

/**
 * prisma.config.ts から呼ぶ、Prisma CLI の接続先ガード（2-7）。DBには接続しない。
 *
 * - `KATANA_DB_TARGET` が未設定：開発・本番用の従来の動作。`{ mode: "default" }` を返し、呼び出し側は今までどおり
 *   `env("DATABASE_URL")` を使う。`.env.test`・`.env` は読まない。ただし DATABASE_URL がテストDBらしい場合は拒否する
 *   （テストモードを付け忘れたまま、テストDBに対して CLI を実行させない）。
 * - `KATANA_DB_TARGET=test`：テストDBモード。`.env.test` の DATABASE_URL を assertTestDatabaseTarget() で検証し、
 *   プロセスの DATABASE_URL（scripts/testdb-migrate.mts が検証済みの値を渡す）と完全に一致した場合だけ、
 *   `{ mode: "test", url }` を返す。テストDBモードで別の接続先に切り替える経路は持たない。
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
  | "DATABASE_URL_MISMATCH";

export class PrismaCliGuardError extends Error {
  readonly code: PrismaCliGuardErrorCode;
  /** TARGET_REJECTED のときの、assertTestDatabaseTarget() のエラーコード */
  readonly targetCode?: TestDatabaseGuardErrorCode;

  constructor(code: PrismaCliGuardErrorCode, detail: string, targetCode?: TestDatabaseGuardErrorCode) {
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

  // .env の開発用URLを流用させない。プロセスの値は、検証済みの .env.test の値と同じでなければならない
  if (env.DATABASE_URL !== testDatabaseUrl) {
    throw new PrismaCliGuardError("DATABASE_URL_MISMATCH", "DATABASE_URL does not match the verified .env.test value.");
  }
  return { mode: "test", url: testDatabaseUrl };
}
