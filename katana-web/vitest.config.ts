import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // 実DBに書き込む統合テスト（*.integration.test.*）は除外し、専用runnerからだけ実行する
    exclude: [...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"],
    // ワーカーの環境変数は親プロセスの値より優先される。接続できないダミーURLにし、
    // 統合テストのモードも無効にして、本物の lib/prisma.ts を読み込んだら必ず throw させる
    env: {
      DATABASE_URL: "postgresql://no-db@127.0.0.1:9/unit_tests_must_not_connect",
      KATANA_DB_TEST_MODE: "unit",
    },
  },
});
