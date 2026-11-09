/**
 * テストDBの migration の checksum の照合だけを行うスクリプト（Step 3-12B-5C-1）。
 *
 *   npm run testdb:checksums               … 予行。事前の検証とローカルの checksum の計算だけ（Docker・DB に触れない）
 *   npm run testdb:checksums -- --verify   … 実DBでの読み取り専用の照合の意思表示。専用の固定のゲートが無効なので、
 *                                            今は Docker・DB に触れる前に CHECKSUM_LIVE_DISABLED で止まる
 *
 * 手順と検証の内容は lib/testing/testDbChecksums.ts。このファイルは、実際の入出力をつなぐだけ。
 * migration を適用する経路は持たない（Prisma CLI・子プロセスを起動しない。migration 用の LIVE_DATABASE_DISABLED を参照しない）。
 * ゲートは固定の CHECKSUM_DATABASE_DISABLED（環境変数・引数では変えられない）。有効にするのは、承認を得た後続の工程で、このファイルを変えたときだけ。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector・inspectMigrationChecksums）と Docker の読み取りは、
 * ゲートが有効で `--verify` のときに、事前の検証がすべて通った後で呼ばれる（今は呼ばれない）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { inspectMigrationChecksums, readLocalMigrationChecksums } from "../lib/testing/migrationChecksum.ts";
import { CHECKSUM_DATABASE_DISABLED, runTestDbChecksums, TestDbChecksumsError } from "../lib/testing/testDbChecksums.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { readTestDbDockerIdentity, runDockerCommand } from "../lib/testing/testDbDocker.ts";
import { createTestDatabaseInspector } from "../lib/testing/testDbMigrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "prisma", "migrations");

runTestDbChecksums({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  readLocalChecksums: () => readLocalMigrationChecksums(MIGRATIONS_DIR),
  // checksum の照合用の許可は無効（固定）。--verify でも、Docker の読み取り・DBへの接続の前に CHECKSUM_LIVE_DISABLED で止まる
  checksumDatabase: CHECKSUM_DATABASE_DISABLED,
  readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),
  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  inspectChecksums: (input) => inspectMigrationChecksums({ ...input, migrationsDir: MIGRATIONS_DIR, connect: connectTestDatabase }),
  log: (text) => console.log(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 想定したエラーは、接続先を含まないメッセージだけを表示する
    console.error(error instanceof TestDbChecksumsError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
