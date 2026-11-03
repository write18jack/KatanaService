import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type PrismaCliGuardErrorCode,
  type PrismaCliGuardInput,
  PrismaCliGuardError,
  resolvePrismaCliDatabaseTarget,
} from "./prismaCliGuard";

/** 純粋関数の単体テスト（DBに接続せず、Prisma CLI も prisma.config.ts も読み込まない）。URLはすべてダミー値 */
const PASSWORD = "cli-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;

function testModeInput(overrides: { env?: Record<string, string | undefined>; testEnv?: Record<string, string> | undefined; argv?: string[] } = {}) {
  const readTestEnv = vi.fn(() => ("testEnv" in overrides ? overrides.testEnv : { DATABASE_URL: TEST_URL }));
  const readDevelopmentEnv = vi.fn(() => ({ DATABASE_URL: DEV_URL }));
  const input: PrismaCliGuardInput = {
    env: { KATANA_DB_TARGET: "test", DATABASE_URL: TEST_URL, PATH: "/usr/bin", ...overrides.env },
    argv: overrides.argv ?? ["node", "prisma", "migrate", "deploy"],
    readTestEnv,
    readDevelopmentEnv,
  };
  return { input, readTestEnv, readDevelopmentEnv };
}

function defaultModeInput(env: Record<string, string | undefined>) {
  const readTestEnv = vi.fn(() => ({ DATABASE_URL: TEST_URL }));
  const readDevelopmentEnv = vi.fn(() => ({ DATABASE_URL: DEV_URL }));
  const input: PrismaCliGuardInput = { env, argv: ["node", "prisma", "migrate", "dev"], readTestEnv, readDevelopmentEnv };
  return { input, readTestEnv, readDevelopmentEnv };
}

/** 指定したコードで拒否され、メッセージに秘密情報と拒否した値が含まれないこと */
function expectRejected(input: PrismaCliGuardInput, code: PrismaCliGuardErrorCode, targetCode?: string) {
  let caught: unknown;
  try {
    resolvePrismaCliDatabaseTarget(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PrismaCliGuardError);
  const error = caught as PrismaCliGuardError;
  expect(error.code).toBe(code);
  if (targetCode) expect(error.targetCode).toBe(targetCode);
  // Prisma CLI は `Error: ${error}` を表示するので、文字列化した結果でも確かめる
  for (const text of [error.message, String(error)]) {
    for (const secret of [PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"]) {
      expect(text).not.toContain(secret);
    }
  }
  return error;
}

describe("resolvePrismaCliDatabaseTarget：KATANA_DB_TARGET が未設定（開発・本番用の従来の動作）", () => {
  it("開発用のURLでは default を返し、.env.test・.env を読まない（呼び出し側は env(\"DATABASE_URL\") を使う）", () => {
    const { input, readTestEnv, readDevelopmentEnv } = defaultModeInput({ DATABASE_URL: DEV_URL });
    expect(resolvePrismaCliDatabaseTarget(input)).toEqual({ mode: "default" });
    expect(readTestEnv).not.toHaveBeenCalled();
    expect(readDevelopmentEnv).not.toHaveBeenCalled();
  });

  it("DATABASE_URL が未設定でも default を返す（未設定時のエラーは従来どおり env() に任せる）", () => {
    expect(resolvePrismaCliDatabaseTarget(defaultModeInput({}).input)).toEqual({ mode: "default" });
  });

  it("解析できないURL・ほかのホストのURLは、従来どおり default を返す", () => {
    for (const url of ["not a url", "postgresql://app:pw@db.example.com:5432/katana_prod", "postgresql://u:p@127.0.0.1:5433/other"]) {
      expect(resolvePrismaCliDatabaseTarget(defaultModeInput({ DATABASE_URL: url }).input)).toEqual({ mode: "default" });
    }
  });

  it("PG*・DOTENV_*・NODE_OPTIONS があっても、従来の動作を変えない", () => {
    const env = { DATABASE_URL: DEV_URL, PGHOST: "x", DOTENV_CONFIG_PATH: "y", NODE_OPTIONS: "--no-warnings" };
    expect(resolvePrismaCliDatabaseTarget(defaultModeInput(env).input)).toEqual({ mode: "default" });
  });

  it.each([
    ["テストDBのURLそのもの", TEST_URL],
    ["DB名が katana_test", "postgresql://someone:pw@db.example.com:5432/katana_test"],
    ["ユーザーが katana_test_user", "postgresql://katana_test_user:pw@localhost:5433/katana"],
    ["ループバックの5434番ポート", "postgresql://u:pw@localhost:5434/other"],
  ])("テストDBらしいURL（%s）は、テストモードなしでは拒否する", (_label, url) => {
    expectRejected(defaultModeInput({ DATABASE_URL: url }).input, "TEST_URL_WITHOUT_TEST_TARGET");
  });
});

describe("resolvePrismaCliDatabaseTarget：KATANA_DB_TARGET の値", () => {
  it.each(["", "TEST", "test ", "integration", "dev"])("%j は拒否する（.env.test も読まない）", (value) => {
    const { input, readTestEnv } = testModeInput({ env: { KATANA_DB_TARGET: value } });
    expectRejected(input, "TARGET_INVALID");
    expect(readTestEnv).not.toHaveBeenCalled();
  });
});

describe("resolvePrismaCliDatabaseTarget：KATANA_DB_TARGET=test", () => {
  it("正しいテストDBのURLで、プロセスの値と .env.test の値が一致すれば許可する", () => {
    const { input, readTestEnv, readDevelopmentEnv } = testModeInput();
    expect(resolvePrismaCliDatabaseTarget(input)).toEqual({ mode: "test", url: TEST_URL });
    expect(readTestEnv).toHaveBeenCalledTimes(1);
    expect(readDevelopmentEnv).toHaveBeenCalledTimes(1);
  });

  it("localhost の表記も許可する", () => {
    const url = TEST_URL.replace("127.0.0.1", "localhost");
    const { input } = testModeInput({ env: { DATABASE_URL: url }, testEnv: { DATABASE_URL: url } });
    expect(resolvePrismaCliDatabaseTarget(input)).toEqual({ mode: "test", url });
  });

  it(".env.test がなければ拒否する", () => {
    expectRejected(testModeInput({ testEnv: undefined }).input, "TEST_ENV_MISSING");
  });

  it(".env.test に DATABASE_URL がなければ拒否する", () => {
    expectRejected(testModeInput({ testEnv: {} }).input, "TARGET_REJECTED", "URL_MISSING");
  });

  it.each([
    ["開発用DBのURL", DEV_URL, "PORT_NOT_ALLOWED"],
    ["ポート5433", TEST_URL.replace(":5434", ":5433"), "PORT_NOT_ALLOWED"],
    ["ポートの省略", TEST_URL.replace(":5434", ""), "PORT_NOT_ALLOWED"],
    ["DB名が katana", TEST_URL.replace(/\/katana_test$/, "/katana"), "DATABASE_NOT_ALLOWED"],
    ["ユーザーが katana", TEST_URL.replace("katana_test_user", "katana"), "USER_NOT_ALLOWED"],
    ["パスワードなし", "postgresql://katana_test_user@127.0.0.1:5434/katana_test", "PASSWORD_MISSING"],
    ["ほかのホスト", TEST_URL.replace("127.0.0.1", "db.example.com"), "HOST_NOT_ALLOWED"],
    ["クエリパラメータ", `${TEST_URL}?host=/tmp`, "QUERY_NOT_ALLOWED"],
  ])(".env.test が %s なら拒否する（プロセスの値が同じでも）", (_label, url, targetCode) => {
    const { input } = testModeInput({ env: { DATABASE_URL: url }, testEnv: { DATABASE_URL: url } });
    expectRejected(input, "TARGET_REJECTED", targetCode);
  });

  it("開発用DBと同じ文字列なら拒否する", () => {
    const { input } = testModeInput();
    expectRejected({ ...input, readDevelopmentEnv: () => ({ DATABASE_URL: TEST_URL }) }, "TARGET_REJECTED", "MATCHES_DEVELOPMENT_DATABASE");
  });

  it.each([
    ["PGHOST", "PG_ENV_PRESENT"],
    ["PGPASSWORD", "PG_ENV_PRESENT"],
    ["DOTENV_CONFIG_PATH", "DOTENV_ENV_PRESENT"],
    ["DOTENV_CONFIG_OVERRIDE", "DOTENV_ENV_PRESENT"],
  ])("%s が設定されていれば拒否する（値が空でも）", (key, targetCode) => {
    expectRejected(testModeInput({ env: { [key]: "" } }).input, "TARGET_REJECTED", targetCode);
  });

  it("NODE_OPTIONS が設定されていれば、.env.test を読む前に拒否する", () => {
    const { input, readTestEnv } = testModeInput({ env: { NODE_OPTIONS: "--require ./x.js" } });
    expectRejected(input, "NODE_OPTIONS_PRESENT");
    expect(readTestEnv).not.toHaveBeenCalled();
  });

  it("dotenv_config_* の引数があれば、.env.test を読む前に拒否する", () => {
    const { input, readTestEnv } = testModeInput({ argv: ["node", "prisma", "migrate", "deploy", "dotenv_config_path=.env"] });
    expectRejected(input, "DOTENV_ARGUMENT_PRESENT");
    expect(readTestEnv).not.toHaveBeenCalled();
  });

  it("dotenv/config が .env の開発用URLを補った場合（プロセスの値が開発用）は拒否する", () => {
    expectRejected(testModeInput({ env: { DATABASE_URL: DEV_URL } }).input, "DATABASE_URL_MISMATCH");
  });

  it("プロセスの DATABASE_URL が未設定なら拒否する（.env.test の値を黙って使わない）", () => {
    expectRejected(testModeInput({ env: { DATABASE_URL: undefined } }).input, "DATABASE_URL_MISMATCH");
  });

  it("プロセスの値が、検証済みの値と1文字でも違えば拒否する", () => {
    const other = TEST_URL.replace(PASSWORD, `${PASSWORD}x`);
    expectRejected(testModeInput({ env: { DATABASE_URL: other } }).input, "DATABASE_URL_MISMATCH");
  });
});

describe("prisma.config.ts（ソースの静的確認。読み込みはしない）", () => {
  const source = readFileSync(path.resolve(__dirname, "../../prisma.config.ts"), "utf8");

  it("ガードの結果がテストモードのときだけ検証済みのURLを使い、それ以外は従来どおり env(\"DATABASE_URL\") を使う", () => {
    expect(source).toContain('import "dotenv/config";');
    expect(source).toContain("resolvePrismaCliDatabaseTarget(");
    expect(source).toContain('url: databaseTarget.mode === "test" ? databaseTarget.url : env("DATABASE_URL"),');
  });

  it("ガードは defineConfig より前（モジュールの読み込み時）に実行される", () => {
    expect(source.indexOf("resolvePrismaCliDatabaseTarget(")).toBeGreaterThan(-1);
    expect(source.indexOf("resolvePrismaCliDatabaseTarget({")).toBeLessThan(source.indexOf("export default defineConfig("));
  });
});
