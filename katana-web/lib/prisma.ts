import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertIntegrationRuntime } from "./db/testDatabaseGuard";

/**
 * 作業ディレクトリの env ファイル（`.env`・`.env.test`）を dotenv.parse で読む（process.env は変えない）。
 * ファイルがなければ undefined。あるのに読めない・解析できない場合は、検証できないので拒否する。
 * 値は返すだけで表示しない。エラーにはファイル名とエラーコードだけを含める。
 */
function readEnvFileInCwd(fileName: ".env" | ".env.test"): Record<string, string> | undefined {
  let source: string;
  try {
    source = readFileSync(path.resolve(process.cwd(), fileName), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`[lib/prisma] ${fileName} exists but could not be read (${code ?? "unknown error"}); refusing to connect.`);
  }
  try {
    return parse(source);
  } catch {
    throw new Error(`[lib/prisma] ${fileName} could not be parsed; refusing to connect.`);
  }
}

/**
 * Vitest実行中だけ、PrismaPg・PrismaClient を作る前に接続先を検証する。
 * 統合テスト用runnerから起動され、テスト専用DBを指している場合だけ許可し、それ以外はすぐに throw する。
 * 統合テストのモードでは、globalSetup と同じ接続前の検証（assertIntegrationRuntime。R14-1）を行う：
 * runner の目印・禁止する環境変数・`.env.test` の存在・接続先・DATABASE_URL と `.env.test` の完全一致・`.env.test` のパスワード。
 * `.env.test`・`.env` は、検証の直前にここで読む（統合テストのモードのときだけ）。
 * Vitest以外（Next.jsの開発サーバー・本番）では何もしない。
 */
function assertVitestDatabaseAccess(): void {
  const env = process.env;
  const isVitest = env.VITEST !== undefined || env.VITEST_WORKER_ID !== undefined || env.VITEST_POOL_ID !== undefined;
  if (!isVitest) return;

  if (env.KATANA_DB_TEST_MODE !== "integration" || env.KATANA_TEST_RUNNER !== "script") {
    throw new Error(
      '[lib/prisma] The real Prisma Client cannot be loaded in unit tests. Mock "@/lib/prisma", or run DB tests through the integration test runner.',
    );
  }
  assertIntegrationRuntime({
    env,
    testEnv: readEnvFileInCwd(".env.test"),
    developmentDatabaseUrl: readEnvFileInCwd(".env")?.DATABASE_URL,
  });
}

// 既存クライアントの再利用より前に置き、どの経路でも必ず検証を通す
assertVitestDatabaseAccess();

const globalForPrisma = global as unknown as {
  prisma: PrismaClient;
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
