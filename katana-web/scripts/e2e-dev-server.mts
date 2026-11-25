/**
 * F-01 の E2E 用の開発サーバーの起動スクリプト（Step 4-13B）。手順と検証の内容は lib/testing/e2eDevServer.ts。
 * このファイルは、実際の入出力をつなぐだけ。
 *
 *   npm run e2e:dev-server             … 予行（検証と、起動予定のコマンド・環境変数の表示だけ。開発サーバーを起動しない）
 *   npm run e2e:dev-server -- --start  … 開発サーバーの起動。固定のゲート（F-01 の E2E のために一時的に有効化）の下で、検証の後に起動する
 *
 * 8つ目の固定ゲート（devServer）は、F-01 の E2E（docs/E2E-F01-RUNBOOK.md の4章）のために承認を得て、一時的にコードに固定の
 * `{ mode: "enabled" }` にした。環境変数・引数では切り替えない（許可の値は固定のリテラルだけで、条件分岐もない）。
 * ゲートが有効でも、起動は `--start` を付けたときだけで、引数・Node の起動オプション・`.env.test`・接続先・パスワードの検証は省略しない。
 * E2E が終わった後（成功・失敗にかかわらず）、承認を得て、このファイルの値を E2E_DEV_SERVER_DISABLED（lib/testing/e2eDevServer.ts）に戻す。
 * テスト専用の AUTH_SECRET は、起動のたびに node:crypto の乱数で作る（保存も表示もしない）。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2eDevServerError, runE2eDevServer } from "../lib/testing/e2eDevServer.ts";
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
  // E2E 用の開発サーバーの起動の許可（固定。F-01 の E2E のために一時的に有効化。E2E の後、E2E_DEV_SERVER_DISABLED に戻す）
  devServer: { mode: "enabled" },
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
