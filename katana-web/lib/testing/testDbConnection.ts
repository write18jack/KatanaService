import pg from "pg";
import type { IntegrationDbClient } from "./integrationDatabaseCheck.ts";

/**
 * テストDBの読み取り専用の検査（lib/testing/testDbState.ts の classifyTestDatabase）に渡す接続。
 *
 * `pg` を直接 import してよいのは、リポジトリでこのファイルだけ（lib/testing/dbConnectionPaths.test.ts の
 * ALLOWED_PG_DRIVER_FILES。PrismaClient・@prisma/adapter-pg・pg のサブパスは、このファイルでも許可しない）。
 *
 * import しただけでは接続しない。connectTestDatabase() を明示的に呼んだときに、1回だけ接続する。
 * トランザクション（BEGIN READ ONLY・ROLLBACK）と接続の終了は、呼び出し側の runReadOnlyCheck が行う。
 * 接続に失敗した場合は、このファイルの中で接続を閉じてから、元のエラーを投げる（呼び出し側がコードだけを取り出す）。
 *
 * 呼び出し側は、検証済みの接続URLだけを渡す。pg は URL にない設定を PG* の環境変数から補うので、
 * 呼び出し側のプロセスに PG* が設定されていないことを、接続の前に確かめる（testdb-migrate への組み込み時の条件）。
 *
 * 現時点では、どこからも呼ばない（testdb-migrate への組み込みは別工程）。
 */

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

export async function connectTestDatabase(databaseUrl: string): Promise<IntegrationDbClient> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: "katana-testdb-state-check",
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    query: async (sql, params) => ({ rows: (await client.query(sql, params === undefined ? undefined : [...params])).rows }),
    end: () => client.end(),
  };
}
