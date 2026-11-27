import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * 統合テスト（*.integration.test.*）専用の設定。scripts/test-integration.mts からだけ起動する。
 *
 * vitest.config.ts は mergeConfig などで引き継がない。引き継ぐと、test.env のダミーURLと
 * KATANA_DB_TEST_MODE=unit が、runner が設定した値を上書きする（test.env は親プロセスの値より優先される）。
 * 同じ理由で、ここでも test.env は設定しない。
 */
export default defineConfig({
  // Vite に .env・.env.test などを読ませない（接続先は runner が渡す値だけにする）
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.integration.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude],
    globalSetup: ["./lib/testing/integrationGlobalSetup.ts"],
    // 各テストファイルの前に、ワーカーの Prisma Client の接続先を照合する（Step 4-4。第7の固定ゲートが無効なら、Prisma を読み込まずに止まる）
    setupFiles: ["./lib/testing/integrationSetup.ts"],
    // 最初の失敗で、残りのテストファイルを実行しない（接続先の照合の失敗の後に、テストを続けない）
    bail: 1,
    // 全件を集計するテストがあるので、ファイルもテストも1つずつ実行する
    fileParallelism: false,
    maxWorkers: 1,
    // test.concurrent・describe.concurrent が書かれても、同時に1件しか実行しない
    maxConcurrency: 1,
    sequence: { concurrent: false, shuffle: false },
    // テストファイルが1件も選ばれなければ失敗させる（選択条件の誤りを見逃さない）
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
