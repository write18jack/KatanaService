/**
 * F-01 の E2E 用のテストデータの準備と、シナリオごとの DB の変更（Step 4-13C）。手順と検証の内容は lib/testing/testDbE2eFixtures.ts。
 * このファイルは、実際の入出力をつなぐだけ。
 *
 *   npm run testdb:e2e                         … 操作の一覧（DB・Docker に触れない）
 *   npm run testdb:e2e -- --op <操作>          … 予行（DB に接続しない）
 *   npm run testdb:e2e -- --op <操作> --apply  … 実行の意思表示。固定のゲートが無効なので、今は検証の後、DB に接続する前に止まる
 *
 * 9つ目の固定ゲート（fixtures）は、固定の E2E_FIXTURE_DISABLED（無効）。環境変数・引数（`--apply` を含む）では解除できない。
 * 有効にするのは、承認を得た後続の工程で、このファイルの値を変更したときだけ。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector）は、ゲートが有効で `--apply` のときにだけ呼ばれる。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { E2E_FIXTURE_DISABLED, E2eFixtureError, runTestDbE2e } from "../lib/testing/testDbE2eFixtures.ts";
import { createTestDatabaseInspector } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbE2e({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  parentEnv: process.env,
  readEnvFile,
  // ログインの照合（data/user.ts の bcrypt.compare）と同じ bcryptjs。コストは登録（actions/auth/register.ts）と同じ 10
  hashPassword: (password) => bcrypt.hashSync(password, 10),
  // E2E のテストデータの準備・変更の許可は無効（固定）。--apply でも、検証の後、DB に接続する前に E2E_FIXTURE_LIVE_DISABLED で止まる
  fixtures: E2E_FIXTURE_DISABLED,
  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  connect: (databaseUrl) => connectTestDatabase(databaseUrl),
  log: (text) => console.log(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 想定したエラーは、接続先・パスワードを含まないメッセージだけを表示する
    console.error(error instanceof E2eFixtureError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
