/**
 * テストDB専用の migration スクリプト（2-7）。
 *
 *   npm run testdb:migrate        … 予行。検証と、実行予定のコマンドの表示だけを行う（Docker・DB に触れず、Prisma CLI も起動しない）
 *   npm run testdb:migrate -- --apply
 *                                 … migration の実行。固定の migration 用の許可（liveDatabase。Step 4-8B で、テストDB の復旧のために一時的に有効化）の下で、
 *                                   D1 → F1 → D2 → `prisma migrate deploy` → F2 → D3 の順で照合しながら実行する
 *                                   （状態 A のときだけ Prisma CLI を起動する。B は止まり、C は起動せずに終わる）
 *   npm run testdb:migrate:check  … 検証と、実行予定のコマンド・子プロセスの環境変数の表示だけを行う
 *                                   （Prisma CLI を起動せず、DBにも接続しない）
 *   npm run testdb:verify         … 検証の後、読み取り専用の接続で本人確認と状態 A・B・C の判定だけを行う
 *                                   （Prisma CLI を起動しない。migration・DBの変更はしない）
 *
 * 手順と検証の内容は lib/testing/testDbMigrate.ts。このファイルは、実際の入出力をつなぐだけ。
 *
 * migration 用の許可は、Step 4-8B（テストDB の復旧。docs/TESTING.md の6章の手順7）で承認を得て、一時的にコードに固定の `{ mode: "enabled" }` にした
 * （Step 3-12B-1〜3-12B-4 と同じ運用。前回は Step 3-12B-4 で LIVE_DATABASE_DISABLED に戻した）。
 * 環境変数・引数では切り替えない（許可の値は固定のリテラルだけで、条件分岐もない）。許可が有効でも、migration は `--apply` を付けたときだけ行い、
 * 引数なし（予行）・`--check`・`--verify` では Prisma CLI を起動しない。`--apply` でも、引数・Node の起動オプション・`.env.test`・
 * 接続先・パスワード・親の環境変数・子プロセスの環境変数・必要なファイルの検証は省略せず、どれかが失敗すれば Docker・DB に触れる前に止まる。
 * `migrate --apply` を1回実行した後（成功・失敗にかかわらず）、承認を得て、このファイルの値を LIVE_DATABASE_DISABLED（lib/testing/testDbMigrate.ts）に戻す。
 *
 * migration の前後の照合と判定の実装（migrationChecks。Step 3-12A）は、許可とは別に、本物の関数をここで渡す:
 * - readDockerIdentity：lib/testing/testDbDocker.ts の readTestDbDockerIdentity（読み取り専用の docker コマンドだけ。shell なし。
 *   コンテキスト・Compose のプロジェクト・サービス・コンテナを検証。Config.Env は読まない）。D1・D2・D3 で使う
 * - inspectDatabase：createTestDatabaseInspector と connectTestDatabase（読み取り専用の本人確認・権限・状態・識別情報）。F1・F2 で使う
 * どちらも、`--apply` で、かつ許可が有効なときだけ、事前の検証がすべて通った後に呼ばれる（呼ばれたときに初めて、期待値のファイルの
 * 読み込み・Docker の読み取り・接続を行う）。予行・`--check`・`--verify` では呼ばれない。
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
import { createTestDatabaseInspector, runTestDbMigrate, TestDbMigrateError } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbMigrate({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  // migration 用の許可（固定。Step 4-8B でテストDB の復旧のために一時的に有効化。migrate --apply の1回の後、LIVE_DATABASE_DISABLED に戻す）
  liveDatabase: { mode: "enabled" },
  // migration の前後の照合（D1・D2・D3）と判定（F1・F2）。許可が有効で、--apply のときだけ呼ばれる
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
