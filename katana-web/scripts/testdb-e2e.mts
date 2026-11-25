/**
 * F-01 の E2E 用のテストデータの準備と、シナリオごとの DB の変更（Step 4-13C）。手順と検証の内容は lib/testing/testDbE2eFixtures.ts。
 * このファイルは、実際の入出力をつなぐだけ。
 *
 *   npm run testdb:e2e                         … 操作の一覧（DB・Docker に触れない）
 *   npm run testdb:e2e -- --op <操作>          … 予行（DB に接続しない）
 *   npm run testdb:e2e -- --op <操作> --apply  … 操作の実行。固定のゲート（F-01 の E2E のために一時的に有効化）の下で、検証の後に実行する
 *
 * 9つ目の固定ゲート（fixtures）は、F-01 の E2E（docs/E2E-F01-RUNBOOK.md の4章）のために承認を得て、一時的にコードに固定の
 * `{ mode: "enabled" }` にした。環境変数・引数では切り替えない（許可の値は固定のリテラルだけで、条件分岐もない）。
 * ゲートが有効でも、DB を変えるのは `--apply` を付けたときだけで、事前の検証と、実行の前後の状態の確認は省略しない。
 * E2E が終わった後（成功・失敗にかかわらず）、承認を得て、このファイルの値を E2E_FIXTURE_DISABLED（lib/testing/testDbE2eFixtures.ts）に戻す。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector）は、ゲートが有効で `--apply` のときにだけ呼ばれる。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { E2eFixtureError, runTestDbE2e } from "../lib/testing/testDbE2eFixtures.ts";
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
  // E2E のテストデータの準備・変更の許可（固定。F-01 の E2E のために一時的に有効化。E2E の後、E2E_FIXTURE_DISABLED に戻す）
  fixtures: { mode: "enabled" },
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
