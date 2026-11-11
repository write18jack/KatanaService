/**
 * テストDBのカタログの定義の監査だけを行うスクリプト（Step 3-12B-5C-5C）。
 *
 *   npm run testdb:catalog               … 予行。事前の検証と、リポジトリのファイルからの期待値の構築だけ（Docker・DB に触れない）
 *   npm run testdb:catalog -- --verify   … 実DBでの読み取り専用の監査。専用の固定のゲートを Step 3-12B-5D-2 で一時的に
 *                                          読み取り専用の有効（enabled-read-only）にしたので、事前の検証がすべて通れば監査に進む。
 *                                          実DBでの監査は、次の工程の個別の承認を得るまで実行しない
 *
 * 手順と検証の内容は lib/testing/testDbCatalogRunner.ts。このファイルは、実際の入出力をつなぐだけ。
 * 接続するロールは katana_test_user だけ。読み取り専用ロールの検査・Prisma CLI・migration・checksum の経路は持たない。
 * ゲートはこのファイルの固定値（環境変数・引数では変えられない）。Step 3-12B-5D-2 で一時的に `{ mode: "enabled-read-only" }` にした。
 * 実DBでの監査の後、別の工程で固定の CATALOG_AUDIT_DATABASE_DISABLED に戻す。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector・runCatalogDefinitionAudit）と Docker の読み取りは、ここで渡してあるが、
 * ゲートが有効で `--verify` のときに、事前の検証がすべて通った後でだけ呼ばれる（引数なしの予行では呼ばれない）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { loadCatalogAuditExpectation, runCatalogDefinitionAudit } from "../lib/testing/testDbCatalogAudit.ts";
import { runTestDbCatalogAudit, TestDbCatalogError } from "../lib/testing/testDbCatalogRunner.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { readTestDbDockerIdentity, runDockerCommand } from "../lib/testing/testDbDocker.ts";
import { createTestDatabaseInspector } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runTestDbCatalogAudit({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  loadExpectation: () => loadCatalogAuditExpectation(ROOT),
  // カタログの監査用の許可は、読み取り専用の有効（固定。Step 3-12B-5D-2 で一時的に有効化）。--verify のときだけ使われる
  catalogDatabase: { mode: "enabled-read-only" },
  readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),
  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  runAudit: (input) => runCatalogDefinitionAudit({ ...input, connect: connectTestDatabase }),
  log: (text) => console.log(text),
}).then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    // 想定したエラーは、接続先を含まないメッセージだけを表示する
    console.error(error instanceof TestDbCatalogError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
