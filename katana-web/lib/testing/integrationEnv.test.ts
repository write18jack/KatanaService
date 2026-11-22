import { describe, expect, it } from "vitest";
import { IntegrationRunnerError, prepareIntegrationEnv } from "./integrationEnv";

// 統合テスト用runnerの環境変数の準備（scripts/test-integration.mts から呼ぶ）の単体テスト。
// ファイルは読まず、DBにも接続せず、Vitest の子プロセスも起動しない。値はすべてダミー
const PASSWORD = "runner-dummy-pass";
const ADMIN_PASSWORD = "runner-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"];
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const DEVELOPMENT_ENV = { DATABASE_URL: DEV_URL };

function prepare(overrides: { parentEnv?: Record<string, string | undefined>; testEnv?: Record<string, string | undefined> | undefined } = {}) {
  return prepareIntegrationEnv({
    parentEnv: overrides.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    testEnv: "testEnv" in overrides ? overrides.testEnv : GOOD_TEST_ENV,
    developmentEnv: DEVELOPMENT_ENV,
  });
}

/** 拒否され、メッセージに指定したコードが含まれ、パスワード・接続URLが含まれないこと */
function expectRejected(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IntegrationRunnerError);
  const message = (caught as Error).message;
  expect(message).toContain(`(${code})`);
  for (const secret of SECRETS) expect(message).not.toContain(secret);
  return message;
}

describe("prepareIntegrationEnv", () => {
  it("正しい .env.test なら、子プロセスの環境変数を作る。パスワードの2つのキーは子プロセスに渡さない", () => {
    const { childEnv, target } = prepare();
    expect(childEnv).toEqual({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      HOME: "/home/u",
      DATABASE_URL: TEST_URL,
      KATANA_DB_TEST_MODE: "integration",
      KATANA_TEST_RUNNER: "script",
    });
    expect(target).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
  });

  it("接続先が不正なら、パスワードの検証の前に接続先のエラーで拒否する", () => {
    const message = expectRejected(() => prepare({ testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } }), "PORT_NOT_ALLOWED");
    expect(message).toContain("target was rejected");
  });

  it.each([
    ["アプリ用のパスワードがない", { KATANA_TEST_DB_PASSWORD: undefined }, "APP_PASSWORD_MISSING"],
    ["管理用のパスワードがない（DATABASE_URL だけの古い .env.test）", { KATANA_TEST_DB_ADMIN_PASSWORD: undefined }, "ADMIN_PASSWORD_MISSING"],
    ["アプリ用が空", { KATANA_TEST_DB_PASSWORD: "" }, "APP_PASSWORD_MISSING"],
    [
      "見本の値のまま",
      {
        DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_test_password"),
        KATANA_TEST_DB_PASSWORD: "CHANGE_ME_test_password",
        KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password",
      },
      "PASSWORD_PLACEHOLDER",
    ],
    ["URLとアプリ用が違う", { KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, "URL_PASSWORD_MISMATCH"],
    ["管理用がアプリ用と同じ", { KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, "ADMIN_PASSWORD_SAME_AS_APP"],
    ["使えない文字", { KATANA_TEST_DB_ADMIN_PASSWORD: "admin pass" }, "PASSWORD_CHARSET"],
  ])(".env.test の %s なら拒否する（R14）", (_label, override, code) => {
    const message = expectRejected(() => prepare({ testEnv: { ...GOOD_TEST_ENV, ...override } }), code);
    expect(message).toContain("credentials in .env.test were rejected");
  });

  it("親の環境変数のパスワードは使わず、子プロセスにも渡さない（.env.test の値だけを検証する）", () => {
    const parentEnv = { PATH: "/usr/bin", KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
    expectRejected(() => prepare({ parentEnv, testEnv: { DATABASE_URL: TEST_URL } }), "APP_PASSWORD_MISSING");
    const { childEnv, droppedKeys } = prepare({ parentEnv });
    expect(Object.keys(childEnv).filter((key) => key.startsWith("KATANA_TEST_DB_"))).toEqual([]);
    expect(droppedKeys).toEqual(["KATANA_TEST_DB_ADMIN_PASSWORD", "KATANA_TEST_DB_PASSWORD"]);
  });

  it("NODE_OPTIONS が設定されていれば、パスワードが正しくても拒否する（既存の検証を緩めていない）", () => {
    expect(() => prepare({ parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } })).toThrow(/NODE_OPTIONS is set/);
  });

  it("親の PG*・DOTENV_*・DATABASE_URL は子プロセスに渡さない（既存の動作）", () => {
    const { childEnv } = prepare({ parentEnv: { PATH: "/usr/bin", PGHOST: "db.example.com", DOTENV_CONFIG_PATH: ".env", DATABASE_URL: DEV_URL } });
    expect(Object.keys(childEnv).filter((key) => /^(PG|DOTENV_)/.test(key))).toEqual([]);
    expect(childEnv.DATABASE_URL).toBe(TEST_URL);
  });

  it(".env.test がなければ拒否する", () => {
    expect(() => prepare({ testEnv: undefined })).toThrow(IntegrationRunnerError);
  });
});
