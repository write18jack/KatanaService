/**
 * テストDB専用の migration スクリプト（2-7）。
 *
 *   npm run testdb:migrate        … 予行。検証と、実行予定のコマンドの表示だけを行う（Docker・DB に触れず、Prisma CLI も起動しない）
 *   npm run testdb:migrate -- --apply
 *                                 … migration の実行の意思表示。固定の migration 用の許可（liveDatabase）が有効なときだけ、
 *                                   D1 → F1 → D2 → `prisma migrate deploy` → F2 → D3 の順で照合しながら実行する。
 *                                   現時点では許可が無効なので（Step 3-12B-4）、Docker・DB に触れる前に TESTDB_MIGRATION_LIVE_DISABLED で止まる
 *   npm run testdb:migrate:check  … 検証と、実行予定のコマンド・子プロセスの環境変数の表示だけを行う
 *                                   （Prisma CLI を起動せず、DBにも接続しない）
 *   npm run testdb:verify         … 検証の後、読み取り専用の接続で本人確認と状態 A・B・C の判定だけを行う
 *                                   （Prisma CLI を起動しない。migration・DBの変更はしない）
 *
 * 手順と検証の内容は lib/testing/testDbMigrate.ts。このファイルは、実際の入出力をつなぐだけ。
 *
 * migration 用の許可は、固定の LIVE_DATABASE_DISABLED（無効）。Step 3-12B-1 で一時的に `{ mode: "enabled" }` にし、
 * Step 3-12B-3 でテストDBに migration を1回適用した（状態 C）後、Step 3-12B-4 で無効に戻した。
 * 環境変数・引数（`--apply` を含む）では解除できない（許可の値は定数だけで、条件分岐もない）。`--apply` でも、すべての検証の後、
 * Docker の読み取り・DBへの接続・Prisma CLI の起動の前に TESTDB_MIGRATION_LIVE_DISABLED で止まる。
 * 許可を再び有効にするのは、承認を得た後続の工程で、このファイルを変更したときだけ。
 *
 * migration の前後の照合と判定の実装（migrationChecks。Step 3-12A）は、許可とは別に、本物の関数をここで渡す:
 * - readDockerIdentity：lib/testing/testDbDocker.ts の readTestDbDockerIdentity（読み取り専用の docker コマンドだけ。shell なし。
 *   コンテキスト・Compose のプロジェクト・サービス・コンテナを検証。Config.Env は読まない）。D1・D2・D3 で使う
 * - inspectDatabase：createTestDatabaseInspector と connectTestDatabase（読み取り専用の本人確認・権限・状態・識別情報）。F1・F2 で使う
 * どちらも、`--apply` で、かつ許可が有効なときだけ、事前の検証がすべて通った後に呼ばれる（呼ばれたときに初めて、期待値のファイルの
 * 読み込み・Docker の読み取り・接続を行う）。許可が無効な今は呼ばれない。予行・`--check`・`--verify` でも呼ばれない。
 *
 * 読み取り専用の検証モード（--verify）の実DBへの接続は、migration 用とは別の許可 readOnlyDatabase で行う（Step 3-11B で個別の承認を得て有効化）。
 * こちらもコードに固定している（環境変数・引数では変えられない）。migration 用の許可が無効でも、--verify は動く。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector）は、--verify の判定が呼ばれたときにだけ使う。
 * 判定（状態 A・B・C と、migration に必要な権限の読み取り）は BEGIN READ ONLY の中の SELECT・SHOW と ROLLBACK だけで、
 * Prisma CLI は起動しない（lib/testing/testDbMigrate.ts）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { readTestDbDockerIdentity, runDockerCommand } from "../lib/testing/testDbDocker.ts";
import { createTestDatabaseInspector, LIVE_DATABASE_DISABLED, runTestDbMigrate, TestDbMigrateError } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbMigrate({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  // migration 用の許可は無効（固定。Step 3-12B-4 で戻した）。--apply でも、Docker の読み取り・DBへの接続の前に TESTDB_MIGRATION_LIVE_DISABLED で止まる
  liveDatabase: LIVE_DATABASE_DISABLED,
  // migration の前後の照合（D1・D2・D3）と判定（F1・F2）。許可が有効で、--apply のときだけ呼ばれる（今は呼ばれない）
  migrationChecks: {
    readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),
    inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  },
  // 読み取り専用の検証（--verify）用の、実DBへの接続の許可（固定）。migration 用の許可とは共有しない。
  // 期待値のファイルの読み込みと接続は、--verify の判定が呼ばれたときにだけ行う
  readOnlyDatabase: {
    mode: "enabled-read-only",
    inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
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
