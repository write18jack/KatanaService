import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertTestDatabaseTarget } from "./db/testDatabaseGuard";

/**
 * 開発用DBの接続URLを `.env` から読む（process.env は変えない）。
 * `.env` がなければ undefined。あるのに読めない・解析できない場合は、比較できないので拒否する。
 */
function readDevelopmentDatabaseUrl(): string | undefined {
  let source: string;
  try {
    source = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`[lib/prisma] .env exists but could not be read (${code ?? "unknown error"}); refusing to connect.`);
  }
  try {
    return parse(source).DATABASE_URL;
  } catch {
    throw new Error("[lib/prisma] .env could not be parsed; refusing to connect.");
  }
}

/**
 * Vitest実行中だけ、PrismaPg・PrismaClient を作る前に接続先を検証する。
 * 統合テスト用runnerから起動され、テスト専用DBを指している場合だけ許可し、それ以外はすぐに throw する。
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
  assertTestDatabaseTarget({
    databaseUrl: env.DATABASE_URL,
    env,
    developmentDatabaseUrl: readDevelopmentDatabaseUrl(),
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
