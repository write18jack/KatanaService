import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { assertIntegrationProcessEnv } from "./integrationEnv.ts";

/**
 * 統合テストを始める前に、実際に接続したDBがテスト専用DBであり、アプリケーションのテーブルが空であることを確かめる。
 *
 * このモジュールはDBドライバを読み込まない。接続は呼び出し側が `connect` として渡す（pg.Client 互換の最小限のインターフェース）。
 * そのため、単体テストではインメモリの偽のクライアントだけで検証できる。
 *
 * 実行順序（途中で失敗したら、その時点で止める。フォールバックはしない）:
 * 1. runner経由の起動確認  2. DATABASE_URL の形式検証  3. 開発用DBとの接続先比較（1〜3は assertIntegrationProcessEnv）
 * 4. 接続（1回だけ）  5. 接続後の本人確認  6. スキーマ・テーブル構成・migrationの確認  7. 空DB検査
 * 8. すべて成功した場合だけ結果を返す。接続した後は、成功・失敗にかかわらず必ず end() する。
 *
 * 5〜7は `BEGIN READ ONLY` の中で SELECT だけを行い、最後に ROLLBACK する。TRUNCATE・DELETE・DDL・migration・seed は行わない。
 *
 * 限界: SQLで確かめられるのは、接続先のサーバーが返す名前（DB名・ユーザー）とDBのコメントだけで、
 * 物理的にどのサーバー・コンテナかまでは保証できない。サーバー内部のポート（inet_server_port）は、
 * Dockerの公開ポート（5434）と異なるのが普通なので、判定には使わない（情報として返すだけ）。
 *
 * 例外のメッセージには、接続URL・パスワード・ドライバの元のエラーメッセージを含めない（SQLSTATE などのコードだけを含める）。
 *
 * 接続の開始と終了（runReadOnlyCheck）・本人確認（assertDatabaseIdentity）・migration の履歴の比較・空DB検査の部品は、
 * migration の前後の状態判定（lib/testing/testDbState.ts）でも使う。runner 経由の起動確認（1〜3）は、ここだけで行う。
 */

/** テストDBに付けるコメント（2-1。docker/test-db/init/ の初期化SQLで設定する予定） */
export const TEST_DATABASE_MARKER = "katana-test-db";
export const EXPECTED_DATABASE = "katana_test";
export const EXPECTED_USER = "katana_test_user";
/** Prisma の管理用テーブル。アプリケーションのテーブルとは区別し、空DB検査の対象にしない */
export const MIGRATIONS_TABLE = "_prisma_migrations";
const APP_SCHEMA = "public";

export type IntegrationDatabaseCheckErrorCode =
  | "SCHEMA_UNSUPPORTED"
  | "CONNECT_FAILED"
  | "QUERY_FAILED"
  | "NOT_READ_ONLY"
  | "IDENTITY_UNAVAILABLE"
  | "DATABASE_MISMATCH"
  | "CURRENT_USER_MISMATCH"
  | "SESSION_USER_MISMATCH"
  | "MARKER_MISMATCH"
  | "TABLES_MISSING"
  | "UNEXPECTED_RELATIONS"
  | "MIGRATIONS_MISMATCH"
  | "INVALID_IDENTIFIER"
  | "DATA_PRESENT"
  | "CLOSE_FAILED"
  | "TARGET_REJECTED"
  | "SEARCH_PATH_NOT_PINNED"
  | "PRIVILEGES_UNAVAILABLE"
  | "SERVER_IDENTITY_UNAVAILABLE";

export class IntegrationDatabaseCheckError extends Error {
  readonly code: IntegrationDatabaseCheckErrorCode;

  constructor(code: IntegrationDatabaseCheckErrorCode, detail: string) {
    super(`[integrationDatabaseCheck] ${code}: ${detail}`);
    this.name = "IntegrationDatabaseCheckError";
    this.code = code;
  }
}

/** pg.Client と互換の、検査に必要な最小限のインターフェース */
export interface IntegrationDbClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

export type IntegrationDatabaseCheckInput = {
  /** 検査するプロセスの環境変数（globalSetup では process.env） */
  env: EnvSource;
  /** `.env` を dotenv.parse した結果。ファイルがなければ undefined */
  developmentEnv: EnvSource | undefined;
  /** アプリケーションのテーブル名（applicationTablesFromSchema の結果） */
  expectedTables: readonly string[];
  /** 適用済みであるべき migration の名前（listMigrationNames の結果） */
  expectedMigrations: readonly string[];
  /** 検証済みの接続URLで、DBに1回だけ接続する */
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
};

export type VerifiedIntegrationDatabase = {
  database: string;
  user: string;
  /** サーバー内部のポート。判定には使わない（情報のみ） */
  serverPort: number | null;
  tables: string[];
  migrations: number;
};

/** ドライバのエラーから、表示してよいコード（SQLSTATE・ECONNREFUSED など）だけを取り出す */
export function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^E[A-Z_]+$/.test(code) ? code : "unknown";
}

/** 識別子を検証してから二重引用符で囲む。カタログと照合済みの名前だけを渡す */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new IntegrationDatabaseCheckError("INVALID_IDENTIFIER", "a table name contains unsupported characters.");
  }
  return `"${name}"`;
}

/** `@map`・`@@map`・`@@schema`（複数スキーマ）を使った schema.prisma を拒否する */
export function assertSupportedSchema(schemaSource: string): void {
  if (/@@?map\s*\(|@@schema\s*\(|\bschemas\s*=/.test(schemaSource)) {
    throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "@map, @@map and multi-schema settings are not supported.");
  }
}

/**
 * schema.prisma のモデル名を、実テーブル名として返す。
 * `@@map`・`@map`・`@@schema`（複数スキーマ）は、テーブル名・スキーマの対応を正しく扱えないので拒否する。
 * 暗黙の多対多（`_AToB` テーブル）は列挙しないが、DB側に現れれば UNEXPECTED_RELATIONS で拒否される。
 */
export function applicationTablesFromSchema(schemaSource: string): string[] {
  assertSupportedSchema(schemaSource);
  const tables = [...schemaSource.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map((match) => match[1]);
  if (tables.length === 0) throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "no models were found in schema.prisma.");
  return tables.sort();
}

/** prisma/migrations の中で、migration.sql を持つディレクトリの名前 */
export function listMigrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try {
        return statSync(path.join(migrationsDir, entry.name, "migration.sql")).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

export async function select(client: IntegrationDbClient, step: string, sql: string): Promise<Record<string, unknown>[]> {
  try {
    return (await client.query(sql)).rows;
  } catch (error) {
    throw new IntegrationDatabaseCheckError("QUERY_FAILED", `${step} failed (${safeErrorCode(error)}).`);
  }
}

const sortedDifference = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].filter((x) => !b.has(x)).sort();

/**
 * 接続後の本人確認。読み取り専用のトランザクションの中で、DB名・current_user・session_user・DBのコメントを照合する。
 * expectedUser は既定で katana_test_user。読み取り専用ロールの検査（lib/testing/testDbReadOnlyRole.ts）だけが katana_test_ro を渡す。
 */
export async function assertDatabaseIdentity(client: IntegrationDbClient, expectedUser: string = EXPECTED_USER): Promise<{ serverPort: number | null }> {
  const [readOnly] = await select(client, "read-only check", "SHOW transaction_read_only");
  if (readOnly?.transaction_read_only !== "on") {
    throw new IntegrationDatabaseCheckError("NOT_READ_ONLY", "the verification transaction is not read-only.");
  }

  const rows = await select(
    client,
    "identity query",
    `SELECT current_database() AS database, current_user AS "currentUser", session_user AS "sessionUser",
            shobj_description(d.oid, 'pg_database') AS marker, inet_server_port() AS "serverPort"
       FROM pg_catalog.pg_database d
      WHERE d.datname = current_database()`,
  );
  if (rows.length !== 1) throw new IntegrationDatabaseCheckError("IDENTITY_UNAVAILABLE", "the database identity could not be read.");
  const [identity] = rows;
  // 実際の値は表示しない（期待値だけを示す）
  if (identity.database !== EXPECTED_DATABASE) {
    throw new IntegrationDatabaseCheckError("DATABASE_MISMATCH", `current_database() is not ${EXPECTED_DATABASE}.`);
  }
  if (identity.currentUser !== expectedUser) {
    throw new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", `current_user is not ${expectedUser}.`);
  }
  if (identity.sessionUser !== expectedUser) {
    throw new IntegrationDatabaseCheckError("SESSION_USER_MISMATCH", `session_user is not ${expectedUser}.`);
  }
  if (identity.marker !== TEST_DATABASE_MARKER) {
    throw new IntegrationDatabaseCheckError("MARKER_MISMATCH", `the database comment is not "${TEST_DATABASE_MARKER}".`);
  }
  const port = Number(identity.serverPort);
  return { serverPort: identity.serverPort === null || !Number.isInteger(port) ? null : port };
}

/** ユーザーが作れる全スキーマのリレーションが、public の想定テーブルと管理用テーブルだけであること */
async function assertRelations(client: IntegrationDbClient, expectedTables: readonly string[]): Promise<void> {
  const rows = await select(
    client,
    "relation listing",
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND n.nspname NOT LIKE 'pg\\_temp\\_%'`,
  );
  const allowed = new Set([...expectedTables, MIGRATIONS_TABLE]);
  const found = new Set<string>();
  const unexpected: string[] = [];
  for (const row of rows) {
    const name = String(row.name);
    if (row.schema === APP_SCHEMA && row.kind === "r" && allowed.has(name)) found.add(name);
    else unexpected.push(`${String(row.schema)}.${name} (${String(row.kind)})`);
  }
  const missing = sortedDifference(allowed, found);
  if (missing.length > 0) {
    throw new IntegrationDatabaseCheckError("TABLES_MISSING", `expected tables are missing: ${missing.join(", ")}.`);
  }
  if (unexpected.length > 0) {
    throw new IntegrationDatabaseCheckError("UNEXPECTED_RELATIONS", `unexpected relations exist: ${unexpected.sort().join(", ")}.`);
  }
}

/** `_prisma_migrations` を読む（public のテーブルとして存在することを確かめた後にだけ呼ぶ） */
export async function readMigrationHistory(client: IntegrationDbClient): Promise<Record<string, unknown>[]> {
  return select(
    client,
    "migration listing",
    `SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
       FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(MIGRATIONS_TABLE)}`,
  );
}

export type MigrationHistoryComparison = {
  /** 期待するのに、正常に完了した記録がないもの */
  missing: string[];
  /** 期待しないのに、正常に完了した記録があるもの */
  extra: string[];
  /** 失敗・未完了・ロールバックの記録の件数 */
  notApplied: number;
  /** 正常に完了した記録が重複しているか */
  duplicated: boolean;
  matches: boolean;
};

/** migration の履歴を、期待する名前の一覧と完全一致で比べる（件数だけの比較はしない） */
export function compareMigrationHistory(rows: readonly Record<string, unknown>[], expectedMigrations: readonly string[]): MigrationHistoryComparison {
  const applied = rows.filter((row) => row.finished === true && row.rolledBack === false).map((row) => String(row.name));
  const notApplied = rows.length - applied.length;
  const appliedSet = new Set(applied);
  const missing = sortedDifference(new Set(expectedMigrations), appliedSet);
  const extra = sortedDifference(appliedSet, new Set(expectedMigrations));
  const duplicated = applied.length !== appliedSet.size;
  return { missing, extra, notApplied, duplicated, matches: notApplied === 0 && missing.length === 0 && extra.length === 0 && !duplicated };
}

/** 想定した migration がすべて適用済みで、失敗・ロールバック・余分なものがないこと */
async function assertMigrations(client: IntegrationDbClient, expectedMigrations: readonly string[]): Promise<void> {
  const { missing, extra, notApplied, matches } = compareMigrationHistory(await readMigrationHistory(client), expectedMigrations);
  if (!matches) {
    throw new IntegrationDatabaseCheckError(
      "MIGRATIONS_MISMATCH",
      `migrations do not match (missing: ${missing.length}, extra: ${extra.length}, failed or rolled back: ${notApplied}).`,
    );
  }
}

/** public の指定したテーブルのうち、1行でもあるものを返す（行数は数えず、存在だけを見る） */
export async function findNonEmptyTables(client: IntegrationDbClient, tables: readonly string[]): Promise<string[]> {
  const nonEmpty: string[] = [];
  for (const table of tables) {
    const sql = `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}) AS "hasRows"`;
    const [row] = await select(client, `empty check of ${table}`, sql);
    if (row?.hasRows !== false) nonEmpty.push(table);
  }
  return nonEmpty;
}

/** アプリケーションの全テーブルに1行もないこと */
async function assertEmpty(client: IntegrationDbClient, expectedTables: readonly string[]): Promise<void> {
  const nonEmpty = await findNonEmptyTables(client, expectedTables);
  if (nonEmpty.length > 0) {
    throw new IntegrationDatabaseCheckError(
      "DATA_PRESENT",
      `tables are not empty: ${nonEmpty.join(", ")}. Recreate the test database (npm run testdb:reset) instead of deleting rows.`,
    );
  }
}

/**
 * 検証済みの接続URLで1回だけ接続し、`BEGIN READ ONLY` の中で check を実行する。
 * 成功・失敗にかかわらず、トランザクションを ROLLBACK で終えて接続を閉じる。失敗が重なったら、最初の失敗を投げる。
 * 接続に失敗しても、別の接続先は試さない。
 */
export async function runReadOnlyCheck<T>(
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>,
  databaseUrl: string,
  check: (client: IntegrationDbClient) => Promise<T>,
): Promise<T> {
  let client: IntegrationDbClient;
  try {
    client = await connect(databaseUrl);
  } catch (error) {
    throw new IntegrationDatabaseCheckError("CONNECT_FAILED", `could not connect to the test database (${safeErrorCode(error)}).`);
  }

  let failure: unknown;
  let result: T | undefined;
  let began = false;
  try {
    await select(client, "BEGIN READ ONLY", "BEGIN READ ONLY");
    began = true;
    result = await check(client);
  } catch (error) {
    failure = error;
  }

  if (began) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      failure ??= new IntegrationDatabaseCheckError("QUERY_FAILED", `ROLLBACK failed (${safeErrorCode(error)}).`);
    }
  }
  try {
    await client.end();
  } catch (error) {
    failure ??= new IntegrationDatabaseCheckError("CLOSE_FAILED", `the connection could not be closed (${safeErrorCode(error)}).`);
  }

  if (failure !== undefined) throw failure;
  return result as T;
}

/**
 * 接続前の検証・接続後の本人確認・テーブル構成とmigrationの確認・空DB検査を、この順に行う。
 * すべて成功した場合だけ結果を返し、それ以外は IntegrationDatabaseCheckError（または接続前の検証のエラー）を投げる。
 */
export async function verifyIntegrationDatabase(input: IntegrationDatabaseCheckInput): Promise<VerifiedIntegrationDatabase> {
  const { env, developmentEnv, connect } = input;
  // 期待値を先に確定させる（空の一覧や不正な名前のまま接続しない）
  const expectedTables = [...new Set(input.expectedTables)].sort();
  if (expectedTables.length === 0) throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "no expected tables were given.");
  if (expectedTables.includes(MIGRATIONS_TABLE)) {
    throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", `${MIGRATIONS_TABLE} must not be an application table.`);
  }
  expectedTables.forEach(quoteIdentifier);
  if (input.expectedMigrations.length === 0) {
    throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "no expected migrations were given.");
  }

  // 1〜3：接続する前に、起動経路と接続URLを検証する
  const target = assertIntegrationProcessEnv(env, developmentEnv);
  const databaseUrl = env.DATABASE_URL as string;

  // 4：接続は1回だけ。失敗しても別の接続先は試さない。5〜7の後、成功・失敗にかかわらず接続を閉じる
  return runReadOnlyCheck(connect, databaseUrl, async (client) => {
    const { serverPort } = await assertDatabaseIdentity(client); // 5
    await assertRelations(client, expectedTables); // 6
    await assertMigrations(client, input.expectedMigrations); // 6
    await assertEmpty(client, expectedTables); // 7
    return { database: target.database, user: target.user, serverPort, tables: expectedTables, migrations: input.expectedMigrations.length };
  });
}
