import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { assertTestDatabaseTarget, TestDatabaseGuardError, type TestDatabaseTarget } from "../db/testDatabaseGuard.ts";

/**
 * 統合テスト用runner（scripts/test-integration.mts）と globalSetup が共通で使う、環境変数の準備と検証。
 * DBには接続しない。`.env`・`.env.test` は dotenv.parse で読むだけで、process.env は変えない。
 * runner から Node が直接読み込むため、`@/` エイリアスは使わず、ローカルの import は拡張子付きで書く。
 *
 * エラーメッセージには、接続URL・パスワード・接続先（ホスト・ポート・DB名・ユーザー）を含めない。
 */

export const INTEGRATION_VITEST_CONFIG = "vitest.integration.config.ts";
export const INTEGRATION_TEST_INCLUDE = "**/*.integration.test.{ts,tsx}";
/** テストDBの接続URL（キー DATABASE_URL）を置くファイル。親プロセスの DATABASE_URL は使わない */
export const TEST_ENV_FILE = ".env.test";
/** 開発用DBの接続URL。同じ接続先を拒否するための比較にだけ使う */
export const DEVELOPMENT_ENV_FILE = ".env";

/** 子プロセスに引き継ぐ親の環境変数。これ以外（PG*・DOTENV_*・NODE_OPTIONS・DATABASE_URL など）はすべて落とす */
const INHERITED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
]);
const INHERITED_ENV_PATTERN = /^LC_[A-Z]+$/;
/** 走査しないディレクトリ（Vitest の既定の除外に合わせる） */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", "out", "build", "dist"]);

export class IntegrationRunnerError extends Error {
  constructor(message: string) {
    super(`[test-integration] ${message}`);
    this.name = "IntegrationRunnerError";
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/** env ファイルを dotenv.parse で読む。ファイルがなければ undefined。あるのに読めなければ throw */
export function readEnvFile(filePath: string): Record<string, string> | undefined {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new IntegrationRunnerError(`${path.basename(filePath)} exists but could not be read (${code ?? "unknown error"}).`);
  }
  return parse(source);
}

/** 検証関数を実行し、失敗したらエラーコードだけを含むエラーに置き換える（拒否された値を表示しない） */
function verifyTarget(databaseUrl: string | undefined, env: EnvSource, developmentEnv: EnvSource | undefined): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new IntegrationRunnerError(`the test database target was rejected (${error.code}).`);
    }
    throw error;
  }
}

export type PreparedIntegrationEnv = {
  /** 子プロセス（Vitest）に渡す環境変数 */
  childEnv: Record<string, string> & { NODE_ENV: "test" };
  /** 検証に通った接続先（パスワードを含まない。表示はしない） */
  target: TestDatabaseTarget;
  /** 親から引き継がなかった環境変数の名前 */
  droppedKeys: string[];
};

/**
 * runner が子プロセスに渡す環境変数を作り、接続先を検証する。DBには接続しない。
 * - 親の環境変数は許可リストのものだけを引き継ぐ。
 * - DATABASE_URL は `.env.test` の値だけを使う（親の値・`.env` の値は使わない）。
 * - KATANA_DB_TEST_MODE=integration・KATANA_TEST_RUNNER=script・NODE_ENV=test を設定する。
 */
export function prepareIntegrationEnv(input: {
  parentEnv: EnvSource;
  /** `.env.test` を dotenv.parse した結果。ファイルがなければ undefined */
  testEnv: EnvSource | undefined;
  /** `.env` を dotenv.parse した結果。ファイルがなければ undefined */
  developmentEnv: EnvSource | undefined;
}): PreparedIntegrationEnv {
  const { parentEnv, testEnv, developmentEnv } = input;

  if (testEnv === undefined) {
    throw new IntegrationRunnerError(`${TEST_ENV_FILE} was not found; create it before running integration tests.`);
  }
  // runner 自身の読み込みに影響する。子プロセスには渡さないが、設定されていること自体を拒否する
  if (parentEnv.NODE_OPTIONS !== undefined && parentEnv.NODE_OPTIONS !== "") {
    throw new IntegrationRunnerError("NODE_OPTIONS is set; unset it before running integration tests.");
  }

  // NODE_ENV は親から引き継がず、Vitest が未設定時に使う値（test）を明示する
  const childEnv: PreparedIntegrationEnv["childEnv"] = { NODE_ENV: "test" };
  const droppedKeys: string[] = [];
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_KEYS.has(key) || INHERITED_ENV_PATTERN.test(key)) childEnv[key] = value;
    else droppedKeys.push(key);
  }

  const databaseUrl = testEnv.DATABASE_URL;
  if (databaseUrl !== undefined) childEnv.DATABASE_URL = databaseUrl;
  childEnv.KATANA_DB_TEST_MODE = "integration";
  childEnv.KATANA_TEST_RUNNER = "script";

  const target = verifyTarget(databaseUrl, childEnv, developmentEnv);
  return { childEnv, target, droppedKeys: droppedKeys.sort() };
}

/**
 * globalSetup など、runner から起動された Vitest のプロセスの中で、起動経路と接続先をもう一度検証する。DBには接続しない。
 */
export function assertIntegrationProcessEnv(env: EnvSource, developmentEnv: EnvSource | undefined): TestDatabaseTarget {
  if (env.KATANA_DB_TEST_MODE !== "integration" || env.KATANA_TEST_RUNNER !== "script") {
    throw new IntegrationRunnerError("integration tests must be started through scripts/test-integration.mts.");
  }
  return verifyTarget(env.DATABASE_URL, env, developmentEnv);
}

/** 統合テスト用の設定が選ぶはずのテストファイル（確認モード用。ファイル名の照合だけで、読み込まない） */
export function listIntegrationTestFiles(root: string, dir = ""): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = dir ? path.posix.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : listIntegrationTestFiles(root, relative);
    return entry.isFile() && path.posix.matchesGlob(relative, INTEGRATION_TEST_INCLUDE) ? [relative] : [];
  });
}
