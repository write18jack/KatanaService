import { type IntegrationTeardown, runIntegrationGlobalSetup } from "./integrationDatabaseSetup.ts";
import { readIntegrationRuntimeFiles } from "./integrationEnv.ts";
import { connectTestDatabase } from "./testDbConnection.ts";
import { createTestDatabaseInspector } from "./testDbMigrate.ts";

/**
 * 統合テストの globalSetup。Vitest のメインプロセスで、テストファイルを読み込む前に1回だけ実行される。
 * 処理の本体は lib/testing/integrationDatabaseSetup.ts の runIntegrationGlobalSetup。ここは、固定のゲートと実際の部品を渡すだけ。
 *
 * 1. `.env.test`・`.env` を読み、接続前の検証（R14-1。DBには接続しない）
 * 2. 第7の固定ゲート integrationDatabase。**Step 4-10 で、統合テストを1回実行するために、承認を得て一時的に固定のリテラル
 *    `{ mode: "enabled" }` にした**（setupFiles の lib/testing/integrationSetup.ts と同じ commit で、同じ値）。
 *    環境変数・引数では切り替えない。統合テストの1回の実行の後、承認を得て、2か所とも INTEGRATION_DATABASE_DISABLED に戻す
 * 3. （ゲートが有効なときだけ）読み取り専用の検査で状態 C とサーバーの識別情報を確かめ、テストの終了後に再確認する teardown を返す
 *
 * 接続の部品（createTestDatabaseInspector・connectTestDatabase）は、inspectDatabase が呼ばれたときにだけ作る
 * （import しただけでは接続せず、schema.prisma・migration も読まない）。
 * 自動の TRUNCATE・DELETE・migration・seed・reset は行わない。
 */
export default function setup(): Promise<IntegrationTeardown> {
  const root = process.cwd();
  return runIntegrationGlobalSetup({
    env: process.env,
    readFiles: () => readIntegrationRuntimeFiles(root),
    integrationDatabase: { mode: "enabled" },
    inspectDatabase: (input) => createTestDatabaseInspector({ root, connect: connectTestDatabase })(input),
  });
}
