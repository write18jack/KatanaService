import { INTEGRATION_DATABASE_DISABLED, type IntegrationTeardown, runIntegrationGlobalSetup } from "./integrationDatabaseSetup.ts";
import { readIntegrationRuntimeFiles } from "./integrationEnv.ts";
import { connectTestDatabase } from "./testDbConnection.ts";
import { createTestDatabaseInspector } from "./testDbMigrate.ts";

/**
 * 統合テストの globalSetup。Vitest のメインプロセスで、テストファイルを読み込む前に1回だけ実行される。
 * 処理の本体は lib/testing/integrationDatabaseSetup.ts の runIntegrationGlobalSetup。ここは、固定のゲートと実際の部品を渡すだけ。
 *
 * 1. `.env.test`・`.env` を読み、接続前の検証（R14-1。DBには接続しない）
 * 2. 第7の固定ゲート integrationDatabase。**INTEGRATION_DATABASE_DISABLED（無効）を固定で渡すので、ここで必ず止まる。**
 *    環境変数・引数では有効にできない。有効にするには、承認を得てこの行を変え、commit する
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
    integrationDatabase: INTEGRATION_DATABASE_DISABLED,
    inspectDatabase: (input) => createTestDatabaseInspector({ root, connect: connectTestDatabase })(input),
  });
}
