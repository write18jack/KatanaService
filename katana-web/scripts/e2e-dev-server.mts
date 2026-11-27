/**
 * F-01 の E2E 用の開発サーバーの起動スクリプト（Step 4-13B）。手順と検証の内容は lib/testing/e2eDevServer.ts。
 * このファイルは、実際の入出力をつなぐだけ。
 *
 *   npm run e2e:dev-server             … 予行（検証と、起動予定のコマンド・環境変数の表示だけ。開発サーバーを起動しない）
 *   npm run e2e:dev-server -- --start  … 起動の意思表示。固定のゲートが無効なので、今は検証の後、起動の前に止まる
 *
 * 8つ目の固定ゲート（devServer）は、固定の E2E_DEV_SERVER_DISABLED（無効）。環境変数・引数（`--start` を含む）では解除できない。
 * 有効にするのは、承認を得た後続の工程で、このファイルの値を変更したときだけ。
 * テスト専用の AUTH_SECRET は、起動のたびに node:crypto の乱数で作る（保存も表示もしない）。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_DEV_SERVER_DISABLED, E2eDevServerError, runE2eDevServer } from "../lib/testing/e2eDevServer.ts";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runE2eDevServer({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  generateSecret: () => randomBytes(32).toString("base64url"),
  // E2E 用の開発サーバーの起動の許可は無効（固定）。--start でも、検証の後、起動の前に E2E_DEV_SERVER_LIVE_DISABLED で止まる
  devServer: E2E_DEV_SERVER_DISABLED,
  spawn: (command, args, options) =>
    new Promise((resolve, reject) => {
      // NODE_ENV は設定しない（型の上で必須になっているだけなので、値は変えずに型だけ合わせる。scripts/testdb-migrate.mts と同じ）
      const child = spawn(command, args, { ...options, env: options.env as NodeJS.ProcessEnv });
      child.on("error", reject);
      // シグナルで終了した場合（code が null）も失敗として扱う
      child.on("exit", (code) => resolve(code ?? 1));
    }),
  log: (text) => console.log(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 想定したエラーは、接続先・秘密の値を含まないメッセージだけを表示する
    console.error(error instanceof E2eDevServerError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
