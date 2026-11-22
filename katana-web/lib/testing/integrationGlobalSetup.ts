import { assertIntegrationRuntimeEnv, readIntegrationRuntimeFiles } from "./integrationEnv.ts";

/**
 * 統合テストの globalSetup。Vitest のメインプロセスで、テストファイルを読み込む前に1回だけ実行される。
 *
 * 1. `.env.test`・`.env` を読む（読むだけ。runner は katana-web/ を作業ディレクトリにして起動する）。
 * 2. 接続前の検証（R14-1。DBには接続しない）：実行モードと runner の目印、禁止する環境変数、`.env.test` の存在、
 *    DATABASE_URL がテストDBを指し `.env.test` の値と完全に一致すること、`.env.test` のパスワード。
 *    runner を通さずに起動された場合も、ここで同じ条件を満たさなければ止まる。
 *
 * 接続後の照合（current_database()・current_user・DBのコメント）と、データが残っていないかの読み取り確認は
 * まだここから呼ばない（DBへの接続は、承認を得た後続のStepで組み込む）。それまでは、テストを始めずに必ず停止する。
 * 自動の TRUNCATE・DELETE・migration・seed は、後続のStepでも行わない。
 */
export default function setup(): void {
  assertIntegrationRuntimeEnv(process.env, readIntegrationRuntimeFiles(process.cwd()));

  throw new Error(
    "[integrationGlobalSetup] Post-connection verification and the empty-database check are not implemented yet; refusing to start integration tests.",
  );
}
