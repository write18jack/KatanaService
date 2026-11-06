import pg from "pg";
import { type IntegrationDbClient, safeErrorCode } from "./integrationDatabaseCheck.ts";

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
 * 呼び出し元は scripts/testdb-migrate.mts の --verify（読み取り専用の検証）だけ。
 *
 * 予期しない切断（Step 3-11C）：pg の Client は、接続した後にソケットのエラー・サーバーからの切断があると `error` イベントを出す。
 * リスナーがないと Node の未処理の例外になり、ドライバの生のメッセージを表示してプロセスが止まる（ROLLBACK・end も行われない）。
 * そのため、接続を始める前にリスナーを登録し、最初のエラーのコード（safeErrorCode。SQLSTATE・`E…` だけ）を覚える。
 * 生のメッセージは保持・表示しない。それ以降の query・end は、そのコードを持つエラーで失敗させる（成功とは扱わない）。
 * 再接続はしない。リスナーは外さない（end の後に届いたイベントで、プロセスが止まらないようにする）。
 */

const CONNECT_TIMEOUT_MS = 10_000;
/** 切断のコードが取れない場合（pg の「Connection terminated unexpectedly」にはコードがない）に使うコード */
export const CONNECTION_LOST_CODE = "ECONNLOST";
const QUERY_TIMEOUT_MS = 30_000;

export async function connectTestDatabase(databaseUrl: string): Promise<IntegrationDbClient> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    application_name: "katana-testdb-state-check",
  });

  // 接続を始める前に登録する。最初のエラーのコードだけを覚え、元のエラー（メッセージ）は捨てる
  let lostCode: string | undefined;
  client.on("error", (error: unknown) => {
    if (lostCode !== undefined) return;
    const code = safeErrorCode(error);
    lostCode = code === "unknown" ? CONNECTION_LOST_CODE : code;
  });
  const connectionLost = () => Object.assign(new Error("the test database connection was lost."), { code: lostCode });

  try {
    await client.connect();
    if (lostCode !== undefined) throw connectionLost();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    query: async (sql, params) => {
      if (lostCode !== undefined) throw connectionLost();
      try {
        return { rows: (await client.query(sql, params === undefined ? undefined : [...params])).rows };
      } catch (error) {
        // 切断によるクエリの失敗は、ドライバのエラーではなく、切断のコードで返す
        throw lostCode !== undefined ? connectionLost() : error;
      }
    },
    end: async () => {
      await client.end();
      // 接続を閉じる前に切断が起きていたら、閉じられても成功とは扱わない
      if (lostCode !== undefined) throw connectionLost();
    },
  };
}
