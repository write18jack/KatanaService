/**
 * テストDBの migration の checksum の照合だけを行うスクリプト（Step 3-12B-5C-1）。
 *
 *   npm run testdb:checksums               … 予行。事前の検証とローカルの checksum の計算だけ（Docker・DB に触れない）
 *   npm run testdb:checksums -- --verify   … 実DBでの読み取り専用の照合。専用の固定のゲートを Step 3-12B-5C-3B で一時的に
 *                                            読み取り専用の有効（enabled-read-only）にしたので、事前の検証がすべて通れば照合に進む
 *
 * 手順と検証の内容は lib/testing/testDbChecksums.ts。このファイルは、実際の入出力をつなぐだけ。
 * migration を適用する経路は持たない（Prisma CLI・子プロセスを起動しない。migration 用の LIVE_DATABASE_DISABLED を参照しない）。
 * ゲートはこのファイルの固定値（環境変数・引数では変えられない）。Step 3-12B-5C-3B で一時的に `{ mode: "enabled-read-only" }` にした。
 * 実DBでの照合の後、別の工程で固定の CHECKSUM_DATABASE_DISABLED に戻す。
 * 接続の部品（connectTestDatabase・createTestDatabaseInspector・inspectMigrationChecksums）と Docker の読み取りは、
 * ゲートが有効で `--verify` のときに、事前の検証がすべて通った後でだけ呼ばれる（引数なしの予行では呼ばれない）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { inspectMigrationChecksums, readLocalMigrationChecksums } from "../lib/testing/migrationChecksum.ts";
import { runTestDbChecksums, TestDbChecksumsError } from "../lib/testing/testDbChecksums.ts";
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
  // checksum の照合用の許可は、読み取り専用の有効（固定。Step 3-12B-5C-3B で一時的に有効化）。--verify のときだけ使われる
  checksumDatabase: { mode: "enabled-read-only" },
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
