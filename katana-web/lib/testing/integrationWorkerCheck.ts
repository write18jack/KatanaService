import { type IntegrationDatabaseAccess, IntegrationSetupError } from "./integrationDatabaseSetup.ts";
import {
  EXPECTED_DATABASE,
  EXPECTED_USER,
  IntegrationDatabaseCheckError,
  safeErrorCode,
  TEST_DATABASE_MARKER,
} from "./integrationDatabaseCheck.ts";
import { assertIntegrationRuntimeEnv, type IntegrationRuntimeFiles } from "./integrationEnv.ts";

/**
 * 統合テストの setupFiles（lib/testing/integrationSetup.ts）の本体（Step 4-4）。各テストファイルの前に、ワーカーで実行される。
 *
 * globalSetup（lib/testing/integrationDatabaseSetup.ts）は、メインプロセスで独立した pg の接続を1回だけ使い、全体の状態 C を確かめる。
 * こちらは、テストが実際に使う Prisma Client（@/lib/prisma）が、同じテストDBに接続していることを、テストファイルごとに確かめる。
 * 空DBの検査はしない（テストの途中でデータがあるのは普通。残りは globalSetup の teardown が検出する）。
 *
 * このモジュールは DB ドライバ・Prisma・Docker・子プロセスを読み込まない。Prisma Client の読み込みと SQL の実行は、
 * 呼び出し側が queryIdentity として渡す（setupFiles は、ゲートの確認の後に、動的 import で @/lib/prisma を読み込む）。
 *
 * 順序（最初の失敗で止まる。再試行はしない）:
 * 1. `.env.test`・`.env` を読み、接続前の検証（assertIntegrationRuntimeEnv。R14-1。globalSetup・lib/prisma.ts と同じ条件）
 * 2. 第7の固定ゲート（globalSetup と同じ定義を共用する）。無効なら、queryIdentity を呼ばずに止まる
 * 3. queryIdentity（WORKER_IDENTITY_SQL の SELECT だけ）
 * 4. assertWorkerDatabaseIdentity で照合する。不一致なら throw する
 *
 * DB を変更しない。エラーには、接続URL・パスワード・ドライバの元のメッセージを含めない。
 */

/**
 * setupFiles が Prisma の $queryRaw で実行する SELECT（参照用の正規の文。静的テストで、setupFiles のテンプレートと一致することを確かめる）。
 * 関数・演算子は pg_catalog で修飾し、search_path に依存しない（current_user・session_user は SQL のキーワードで、search_path では解決されない）。
 */
export const WORKER_IDENTITY_SQL = `SELECT pg_catalog.current_database()::text AS "database",
       current_user::text AS "currentUser",
       session_user::text AS "sessionUser",
       pg_catalog.shobj_description(d.oid, 'pg_database') AS "marker"
  FROM pg_catalog.pg_database d
 WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`;

const IDENTITY_FIELDS = ["database", "currentUser", "sessionUser", "marker"] as const;

/**
 * Prisma の $queryRaw が返した行を、テストDBの識別情報（integrationDatabaseCheck.ts の定数）と照合する。純粋な関数。
 * 行がちょうど1行で、4つの項目がすべて文字列であり、期待値と完全に一致すること。実際の値はエラーに含めない。
 */
export function assertWorkerDatabaseIdentity(rows: unknown): void {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new IntegrationDatabaseCheckError("IDENTITY_UNAVAILABLE", "the worker database identity query did not return exactly one row.");
  }
  const [row] = rows as unknown[];
  if (row === null || typeof row !== "object" || !IDENTITY_FIELDS.every((key) => typeof (row as Record<string, unknown>)[key] === "string")) {
    throw new IntegrationDatabaseCheckError("IDENTITY_UNAVAILABLE", "the worker database identity row is missing fields.");
  }
  const identity = row as Record<(typeof IDENTITY_FIELDS)[number], string>;
  if (identity.database !== EXPECTED_DATABASE) {
    throw new IntegrationDatabaseCheckError("DATABASE_MISMATCH", `current_database() is not ${EXPECTED_DATABASE}.`);
  }
  if (identity.currentUser !== EXPECTED_USER) {
    throw new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", `current_user is not ${EXPECTED_USER}.`);
  }
  if (identity.sessionUser !== EXPECTED_USER) {
    throw new IntegrationDatabaseCheckError("SESSION_USER_MISMATCH", `session_user is not ${EXPECTED_USER}.`);
  }
  if (identity.marker !== TEST_DATABASE_MARKER) {
    throw new IntegrationDatabaseCheckError("MARKER_MISMATCH", `the database comment is not "${TEST_DATABASE_MARKER}".`);
  }
}

export type IntegrationWorkerSetupDeps = {
  /** 検査するプロセスの環境変数（setupFiles では process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** `.env.test`・`.env` を読む（setupFiles では readIntegrationRuntimeFiles(process.cwd())） */
  readFiles: () => IntegrationRuntimeFiles;
  /** 第7の固定ゲート。setupFiles は INTEGRATION_DATABASE_DISABLED を固定で渡す */
  integrationDatabase: IntegrationDatabaseAccess;
  /** ゲートが有効なときだけ呼ぶ。Prisma Client を読み込み、WORKER_IDENTITY_SQL の SELECT を実行して、行を返す */
  queryIdentity: () => Promise<unknown>;
};

export async function runIntegrationWorkerSetup(deps: IntegrationWorkerSetupDeps): Promise<void> {
  // 1：接続前の検証
  assertIntegrationRuntimeEnv(deps.env, deps.readFiles());

  // 2：第7の固定ゲート（globalSetup と同じ判定。「enabled」と完全に一致しなければ、Prisma を読み込まない）
  if (deps.integrationDatabase.mode !== "enabled") {
    throw new IntegrationSetupError(
      "INTEGRATION_DATABASE_LIVE_DISABLED",
      "the integration database gate is disabled in this build; refusing to load the Prisma Client in the worker.",
    );
  }

  // 3：Prisma Client の読み込みと SELECT。失敗は、表示してよいコードだけにする
  let rows: unknown;
  try {
    rows = await deps.queryIdentity();
  } catch (error) {
    if (error instanceof IntegrationDatabaseCheckError) throw error;
    throw new IntegrationDatabaseCheckError("QUERY_FAILED", `the worker database identity query failed (${safeErrorCode(error)}).`);
  }

  // 4：照合
  assertWorkerDatabaseIdentity(rows);
}
