/**
 * テストDB専用の migration スクリプト（2-7）。
 *
 *   npm run testdb:migrate        … 検証の後、`prisma migrate deploy` をテストDBに対して実行する
 *   npm run testdb:migrate:check  … 検証と、実行予定のコマンド・子プロセスの環境変数の表示だけを行う
 *                                   （Prisma CLI を起動せず、DBにも接続しない）
 *
 * 手順と検証の内容は lib/testing/testDbMigrate.ts。このファイルは、実際の入出力をつなぐだけ。
 *
 * 現時点では、通常実行モードは必ず停止する。Prisma CLI を起動する前に必要な、接続後の本人確認（DBのコメントの照合）が
 * まだ実装されていないため（DBへの接続は、承認を得た後続のStepで組み込む）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { runTestDbMigrate, TestDbMigrateError } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbMigrate({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  verifyDatabaseIdentity: async () => {
    throw new TestDbMigrateError(
      "IDENTITY_CHECK_NOT_IMPLEMENTED",
      "the pre-migration database identity check is not implemented yet; refusing to start the Prisma CLI.",
    );
  },
  spawn: (command, args, options) =>
    new Promise((resolve, reject) => {
      // NODE_ENV は設定しない（型の上で必須になっているだけなので、値は変えずに型だけ合わせる）
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
    // 想定したエラーは、接続先を含まないメッセージだけを表示する
    console.error(error instanceof TestDbMigrateError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
