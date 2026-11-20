// schemaDiff 専用の Prisma の設定ファイル（Step 3-12B-5E-9A-9-2）。lib/testing/testDbSchemaDiffRunner.ts の固定の
// `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code --config prisma.schemadiff.config.ts` だけが使う。
// 開発用・migration 用の prisma.config.ts とは別のファイルで、dotenv/config を読み込まない（.env の値を process.env に入れない）。
//
// 接続先は katana_test_ro（SELECT だけのロール）の `.env.test.readonly` の URL だけ。KATANA_DB_TARGET=test-readonly・固定のコマンド・
// 環境変数の許可リストと固定の値・URL の SHA-256 の一致を確かめ、1つでも違えば throw する（Prisma CLI は接続せずに終了する）。
// 詳細と残余リスク（URL が schema engine のプロセス引数に出ること）は lib/db/prismaCliGuard.ts の resolvePrismaCliReadOnlyTarget。
import path from "node:path";
import { defineConfig } from "prisma/config";
import { READ_ONLY_TEST_ENV_FILE, resolvePrismaCliReadOnlyTarget, SCHEMA_DIFF_SCHEMA_FILE } from "./lib/db/prismaCliGuard.ts";
import { DEVELOPMENT_ENV_FILE, readEnvFile, TEST_ENV_FILE } from "./lib/testing/integrationEnv.ts";

const readOnlyTarget = resolvePrismaCliReadOnlyTarget({
  env: process.env,
  argv: process.argv,
  cwd: process.cwd(),
  readTestEnv: () => readEnvFile(path.join(process.cwd(), TEST_ENV_FILE)),
  readReadOnlyEnv: () => readEnvFile(path.join(process.cwd(), READ_ONLY_TEST_ENV_FILE)),
  readDevelopmentEnv: () => readEnvFile(path.join(process.cwd(), DEVELOPMENT_ENV_FILE)),
});

// migrations・shadowDatabaseUrl は設定しない（固定のコマンドは migration のディレクトリも shadow DB も使わない）
export default defineConfig({
  schema: SCHEMA_DIFF_SCHEMA_FILE,
  datasource: {
    url: readOnlyTarget.url,
  },
});
