import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIntegrationRuntimeEnv,
  IntegrationRunnerError,
  prepareIntegrationEnv,
  readIntegrationRuntimeFiles,
} from "./integrationEnv";

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

// globalSetup の接続前の検証（R14-1）。ファイルは偽の関数で渡し、DBには接続しない
describe("assertIntegrationRuntimeEnv（R14-1）", () => {
  const RUNNER_ENV = { PATH: "/usr/bin", NODE_ENV: "test", DATABASE_URL: TEST_URL, KATANA_DB_TEST_MODE: "integration", KATANA_TEST_RUNNER: "script" };
  const FILES = { testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV };

  it("runner が作る子プロセスの環境変数と、同じ .env.test なら通る", () => {
    const { childEnv } = prepare();
    expect(assertIntegrationRuntimeEnv(childEnv, FILES)).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
  });

  it.each([
    [".env.test がない", RUNNER_ENV, { testEnv: undefined, developmentEnv: DEVELOPMENT_ENV }, "TEST_ENV_MISSING", "process was rejected"],
    ["runner の目印がない", { ...RUNNER_ENV, KATANA_TEST_RUNNER: undefined }, FILES, "RUNNER_MARKER_MISSING", "process was rejected"],
    ["NODE_OPTIONS がある", { ...RUNNER_ENV, NODE_OPTIONS: "--require x" }, FILES, "FORBIDDEN_ENV_PRESENT", "process was rejected"],
    [
      "DATABASE_URL が .env.test と違う",
      { ...RUNNER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "other-dummy-pass") },
      FILES,
      "DATABASE_URL_MISMATCH",
      "process was rejected",
    ],
    ["DB名が違う", { ...RUNNER_ENV, DATABASE_URL: TEST_URL.replace(/\/katana_test$/, "/katana") }, FILES, "DATABASE_NOT_ALLOWED", "target was rejected"],
    ["ポートが違う", { ...RUNNER_ENV, DATABASE_URL: TEST_URL.replace(":5434", ":5433") }, FILES, "PORT_NOT_ALLOWED", "target was rejected"],
    [
      "パスワードが見本の値",
      { ...RUNNER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x") },
      {
        testEnv: { DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x"), KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD },
        developmentEnv: DEVELOPMENT_ENV,
      },
      "PASSWORD_PLACEHOLDER",
      "credentials in .env.test were rejected",
    ],
    [
      "管理用とアプリ用のパスワードを共用",
      RUNNER_ENV,
      { testEnv: { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, developmentEnv: DEVELOPMENT_ENV },
      "ADMIN_PASSWORD_SAME_AS_APP",
      "credentials in .env.test were rejected",
    ],
  ])("%s なら、コードだけを含むエラーで拒否する", (_label, env, files, code, kind) => {
    const message = expectRejected(() => assertIntegrationRuntimeEnv(env, files), code);
    expect(message).toContain(kind);
  });
});

describe("readIntegrationRuntimeFiles", () => {
  it("作業ディレクトリの .env.test と .env だけを読み、値は検証しない", () => {
    const read = (filePath: string) => ({ "/root/.env.test": { DATABASE_URL: "x" }, "/root/.env": { DATABASE_URL: "y" } })[filePath];
    const requested: string[] = [];
    const files = readIntegrationRuntimeFiles("/root", (filePath) => {
      requested.push(filePath);
      return read(filePath);
    });
    expect(requested).toEqual([path.join("/root", ".env.test"), path.join("/root", ".env")]);
    expect(files).toEqual({ testEnv: { DATABASE_URL: "x" }, developmentEnv: { DATABASE_URL: "y" } });
  });

  it("ファイルがなければ undefined のまま返す（拒否は assertIntegrationRuntimeEnv が行う）", () => {
    expect(readIntegrationRuntimeFiles("/root", () => undefined)).toEqual({ testEnv: undefined, developmentEnv: undefined });
  });
});

// globalSetup のソースを文字列として読むだけ（import しない。Step 4-1）
describe("integrationGlobalSetup の静的検査（R14-1）", () => {
  const source = readFileSync(path.join(__dirname, "integrationGlobalSetup.ts"), "utf8");
  const body = source.slice(source.indexOf("export default function setup"));

  it("接続前の検証を、強制停止の throw より前に1回だけ呼ぶ", () => {
    const guardCall = "assertIntegrationRuntimeEnv(process.env, readIntegrationRuntimeFiles(process.cwd()));";
    expect(body.split(guardCall)).toHaveLength(2);
    expect(body.indexOf(guardCall)).toBeLessThan(body.indexOf("throw new Error("));
  });

  it("強制停止は残っていて、DBへの接続の部品を読み込まない", () => {
    expect(body).toMatch(/throw new Error\(\s*"\[integrationGlobalSetup\][^"]*refusing to start integration tests\.",?\s*\);\s*\}\s*$/);
    for (const forbidden of ["testDbConnection", "connectTestDatabase", "verifyIntegrationDatabase", "classifyTestDatabase", "@/lib/prisma", '"pg"', "child_process"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("古い検証（.env.test を見ない assertIntegrationProcessEnv）は使わない", () => {
    expect(source).not.toContain("assertIntegrationProcessEnv");
  });
});
