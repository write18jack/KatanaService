/**
 * テストDB専用の migration スクリプト（2-7）。
 *
 *   npm run testdb:migrate        … 検証の後、`prisma migrate deploy` をテストDBに対して実行する
 *   npm run testdb:migrate:check  … 検証と、実行予定のコマンド・子プロセスの環境変数の表示だけを行う
 *                                   （Prisma CLI を起動せず、DBにも接続しない）
 *
 * 手順と検証の内容は lib/testing/testDbMigrate.ts。このファイルは、実際の入出力をつなぐだけ。
 *
 * 現時点では、通常実行モードは必ず停止する。実DBへの接続の許可を、固定の LIVE_DATABASE_DISABLED にしているため
 * （TESTDB_MIGRATION_LIVE_DISABLED。すべての検証の後、DBへの接続と Prisma CLI の起動の前に止まる）。
 * 環境変数・引数では解除できない。接続を有効にするのは、承認を得た後続の工程で、このファイルを変更したときだけ
 * （connectTestDatabase を渡した createTestDatabaseClassifier を使う。lib/testing/testDbMigrate.ts）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { LIVE_DATABASE_DISABLED, runTestDbMigrate, TestDbMigrateError } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbMigrate({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  // 実DBへの接続は無効（固定）。通常実行モードは、DBに接続する前に TESTDB_MIGRATION_LIVE_DISABLED で止まる
  liveDatabase: LIVE_DATABASE_DISABLED,
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
