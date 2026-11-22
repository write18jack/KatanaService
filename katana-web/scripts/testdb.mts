/**
 * テスト専用DB（docker-compose.test.yml）の Docker ラッパー（2-5）。
 *
 *   npm run testdb:check            … .env.test・Compose の環境変数・`docker compose config` の結果を検証する（コンテナは操作しない）
 *   npm run testdb:status           … katana-test プロジェクトのコンテナと、開発用ボリュームの状態を読み取るだけ
 *   npm run testdb:identity         … テストDBのコンテナの識別情報（readTestDbDockerIdentity）を読み取るだけ（Step 3-11F。DBには接続しない）
 *   npm run testdb:up               … 起動前の確認だけを行い、実行する予定のコマンドを表示する（コンテナは操作しない）
 *   npm run testdb:up -- --apply    … 確認がすべて通った場合だけ、テストDBのコンテナを作成・起動し、起動後の確認を行う
 *   npm run testdb:down             … 停止前の確認だけを行い、実行する予定のコマンドを表示する（コンテナは操作しない）
 *   npm run testdb:down -- --apply  … 確認がすべて通った場合だけ、katana-test プロジェクトのコンテナを停止・削除する
 *                                     （データは tmpfs にあるので失われる。ボリューム・イメージは削除しない）
 *
 * 検証・Docker の操作の本体（runTestDb・readTestDbDockerIdentity など）は lib/testing/testDbDocker.ts にある
 * （Step 3-12A。migration の照合からも、CLI の main() を起動せずに使えるようにするため）。
 * このファイルは、実際の入出力をつなぐ main() だけを持ち、直接実行したときだけ main() が動く。
 * 単体テスト（scripts/testdb.test.ts）のために、本体の export をそのまま再export する。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { runDockerCommand, runTestDb, TestDbError } from "../lib/testing/testDbDocker.ts";

export * from "../lib/testing/testDbDocker.ts";

function main(): void {
  runTestDb({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    parentEnv: process.env,
    readEnvFile,
    pathExists: existsSync,
    run: runDockerCommand,
    log: (text) => console.log(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // 想定したエラーは、秘密情報を含まないメッセージだけを表示する
      console.error(error instanceof TestDbError || error instanceof IntegrationRunnerError ? error.message : error);
      process.exitCode = 1;
    },
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
