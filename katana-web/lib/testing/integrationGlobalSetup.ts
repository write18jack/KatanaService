import path from "node:path";
import { assertIntegrationProcessEnv, DEVELOPMENT_ENV_FILE, readEnvFile } from "./integrationEnv.ts";

/**
 * 統合テストの globalSetup。Vitest のメインプロセスで、テストファイルを読み込む前に1回だけ実行される。
 *
 * 1. runner（scripts/test-integration.mts）を経由した起動かを確認する。
 * 2. 接続先をもう一度検証する（DBには接続しない）。
 *
 * 接続後の照合（current_database()・current_user・DBのコメント）と、データが残っていないかの読み取り確認は
 * lib/testing/integrationDatabaseCheck.ts の verifyIntegrationDatabase() に実装済みだが、まだここから呼ばない
 * （DBへの接続は、承認を得た後続のStepで組み込む）。それまでは、テストを始めずに必ず停止する。
 * 自動の TRUNCATE・DELETE・migration・seed は、後続のStepでも行わない。
 */
export default function setup(): void {
  // runner は katana-web/ を作業ディレクトリにして起動する（lib/prisma.ts と同じく、cwd の .env と比べる）
  assertIntegrationProcessEnv(process.env, readEnvFile(path.join(process.cwd(), DEVELOPMENT_ENV_FILE)));

  throw new Error(
    "[integrationGlobalSetup] Post-connection verification and the empty-database check are not implemented yet; refusing to start integration tests.",
  );
}
