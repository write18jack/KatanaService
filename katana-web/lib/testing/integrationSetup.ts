import { readIntegrationRuntimeFiles } from "./integrationEnv.ts";
import { runIntegrationWorkerSetup } from "./integrationWorkerCheck.ts";

/**
 * 統合テストの setupFiles（Step 4-4）。vitest.integration.config.ts から、各テストファイルの前にワーカーで実行される。
 * 処理の本体は lib/testing/integrationWorkerCheck.ts の runIntegrationWorkerSetup。ここは、固定のゲートと実際の部品を渡すだけ。
 *
 * 1. `.env.test`・`.env` を読み、接続前の検証（R14-1）
 * 2. 第7の固定ゲート integrationDatabase。**Step 4-10 で、統合テストを1回実行するために、承認を得て一時的に固定のリテラル
 *    `{ mode: "enabled" }` にした**（globalSetup の lib/testing/integrationGlobalSetup.ts と同じ commit で、同じ値）。
 *    環境変数・引数では切り替えない。統合テストの1回の実行の後、承認を得て、2か所とも INTEGRATION_DATABASE_DISABLED に戻す
 * 3. （ゲートが有効なときだけ）@/lib/prisma を動的 import し、$queryRaw の SELECT で接続先を照合する
 *
 * @/lib/prisma は静的に import しない（ゲートが無効なら、Prisma Client を作らない。別の設定ファイルからこのファイルだけを
 * 読み込んだ場合も同じ）。SQL は SELECT だけで、DB を変更しない。
 */
await runIntegrationWorkerSetup({
  env: process.env,
  readFiles: () => readIntegrationRuntimeFiles(process.cwd()),
  integrationDatabase: { mode: "enabled" },
  queryIdentity: async () => {
    const { prisma } = await import("@/lib/prisma");
    return prisma.$queryRaw`SELECT pg_catalog.current_database()::text AS "database",
       current_user::text AS "currentUser",
       session_user::text AS "sessionUser",
       pg_catalog.shobj_description(d.oid, 'pg_database') AS "marker"
  FROM pg_catalog.pg_database d
 WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`;
  },
});
