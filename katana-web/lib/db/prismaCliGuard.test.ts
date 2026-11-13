import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSchemaDiffCliArgs,
  type PrismaCliGuardErrorCode,
  type PrismaCliGuardInput,
  PrismaCliGuardError,
  type PrismaCliReadOnlyGuardInput,
  resolvePrismaCliDatabaseTarget,
  resolvePrismaCliReadOnlyTarget,
  SCHEMA_DIFF_RO_URL_SHA256_ENV,
  schemaDiffUrlSha256,
} from "./prismaCliGuard";

/** 純粋関数の単体テスト（DBに接続せず、Prisma CLI も prisma.config.ts も読み込まない）。URLはすべてダミー値 */
const PASSWORD = "cli-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const ADMIN_PASSWORD = "cli-dummy-admin";
/** 正しい .env.test（パスワードの2つのキーを含む。R14）。url を変えるときは、アプリ用のパスワードはそのまま */
function testEnvFor(url: string = TEST_URL): Record<string, string> {
  return { DATABASE_URL: url, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
}

function testModeInput(overrides: { env?: Record<string, string | undefined>; testEnv?: Record<string, string> | undefined; argv?: string[] } = {}) {
  const readTestEnv = vi.fn(() => ("testEnv" in overrides ? overrides.testEnv : testEnvFor()));
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
    for (const secret of [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"]) {
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
    const { input } = testModeInput({ env: { DATABASE_URL: url }, testEnv: testEnvFor(url) });
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
    const { input } = testModeInput({ env: { DATABASE_URL: url }, testEnv: testEnvFor(url) });
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

  it.each([
    ["アプリ用のパスワードがない", { KATANA_TEST_DB_PASSWORD: undefined }, "APP_PASSWORD_MISSING"],
    ["管理用のパスワードが空", { KATANA_TEST_DB_ADMIN_PASSWORD: "" }, "ADMIN_PASSWORD_MISSING"],
    ["管理用が見本の値", { KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" }, "PASSWORD_PLACEHOLDER"],
    ["URLとアプリ用のパスワードが違う", { KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, "URL_PASSWORD_MISMATCH"],
    ["管理用がアプリ用と同じ", { KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, "ADMIN_PASSWORD_SAME_AS_APP"],
  ])(".env.test の %s なら拒否する（R14）", (_label, override, credentialsCode) => {
    const testEnv = { ...testEnvFor(), ...override } as Record<string, string>;
    expectRejected(testModeInput({ testEnv }).input, "CREDENTIALS_REJECTED", credentialsCode);
  });

  it("URLのパスワードも見本の値なら拒否する（プロセスの値が同じでも。R14）", () => {
    const url = TEST_URL.replace(PASSWORD, "CHANGE_ME_test_password");
    const testEnv = { ...testEnvFor(url), KATANA_TEST_DB_PASSWORD: "CHANGE_ME_test_password" };
    expectRejected(testModeInput({ env: { DATABASE_URL: url }, testEnv }).input, "CREDENTIALS_REJECTED", "PASSWORD_PLACEHOLDER");
  });

  it("プロセスの環境変数のパスワードは使わない（.env.test の値だけを検証する。R14）", () => {
    const { input } = testModeInput({ env: { KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD }, testEnv: { DATABASE_URL: TEST_URL } });
    expectRejected(input, "CREDENTIALS_REJECTED", "APP_PASSWORD_MISSING");
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

// ---- schemaDiff 用（resolvePrismaCliReadOnlyTarget。Step 3-12B-5E-9A-9-2） ----

const RO_PASSWORD = "cli_dummy_ro_password_0123456789abcdef";
const RO_URL = `postgresql://katana_test_ro:${RO_PASSWORD}@127.0.0.1:5434/katana_test`;
const CWD = "/fake/katana-web";
const RO_SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, RO_PASSWORD, TEST_URL, DEV_URL, RO_URL, "postgresql://", "postgres://"];

function readOnlyInput(o: { env?: Record<string, string | undefined>; argv?: string[]; cwd?: string; testEnv?: Record<string, string> | undefined; roEnv?: Record<string, string | undefined> | undefined; devEnv?: Record<string, string> } = {}) {
  const readTestEnv = vi.fn(() => ("testEnv" in o ? o.testEnv : testEnvFor()));
  const readReadOnlyEnv = vi.fn(() => ("roEnv" in o ? o.roEnv : { KATANA_TEST_RO_DATABASE_URL: RO_URL, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD }));
  const readDevelopmentEnv = vi.fn(() => o.devEnv ?? { DATABASE_URL: DEV_URL });
  const input: PrismaCliReadOnlyGuardInput = {
    env: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      CHECKPOINT_DISABLE: "1",
      CI: "1",
      RUST_LOG: "error",
      RUST_BACKTRACE: "0",
      KATANA_DB_TARGET: "test-readonly",
      [SCHEMA_DIFF_RO_URL_SHA256_ENV]: schemaDiffUrlSha256(RO_URL),
      ...o.env,
    },
    argv: o.argv ?? ["/usr/local/bin/node", ...buildSchemaDiffCliArgs(CWD)],
    cwd: o.cwd ?? CWD,
    readTestEnv,
    readReadOnlyEnv,
    readDevelopmentEnv,
  };
  return { input, readTestEnv, readReadOnlyEnv };
}

function expectReadOnlyRejected(input: PrismaCliReadOnlyGuardInput, code: PrismaCliGuardErrorCode, targetCode?: string) {
  let caught: unknown;
  try {
    resolvePrismaCliReadOnlyTarget(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PrismaCliGuardError);
  const error = caught as PrismaCliGuardError;
  expect(error.code).toBe(code);
  if (targetCode) expect(error.targetCode).toBe(targetCode);
  for (const text of [error.message, String(error)]) for (const secret of RO_SECRETS) expect(text).not.toContain(secret);
  return error;
}

describe("resolvePrismaCliReadOnlyTarget：schemaDiff 専用（katana_test_ro だけ）", () => {
  it("固定のコマンド・許可リストの環境変数・固定の値・検証済みの URL の SHA-256 がそろえば、.env.test.readonly の URL を返す", () => {
    const { input } = readOnlyInput();
    expect(resolvePrismaCliReadOnlyTarget(input)).toEqual({ mode: "test-readonly", url: RO_URL });
  });

  it.each([undefined, "test", "TEST-READONLY", "test-readonly "])("KATANA_DB_TARGET=%j は拒否する（ファイルを読まない）", (value) => {
    const { input, readTestEnv, readReadOnlyEnv } = readOnlyInput({ env: { KATANA_DB_TARGET: value } });
    expectReadOnlyRejected(input, "TARGET_INVALID");
    expect(readTestEnv).not.toHaveBeenCalled();
    expect(readReadOnlyEnv).not.toHaveBeenCalled();
  });

  it("既存の resolvePrismaCliDatabaseTarget（prisma.config.ts）は test-readonly を受け付けない（取り違えても接続しない）", () => {
    expectRejected(testModeInput({ env: { KATANA_DB_TARGET: "test-readonly" } }).input, "TARGET_INVALID");
  });

  it("NODE_OPTIONS があれば拒否する（空文字でも）", () => {
    expectReadOnlyRejected(readOnlyInput({ env: { NODE_OPTIONS: "" } }).input, "NODE_OPTIONS_PRESENT");
  });

  it.each([
    ["migrate deploy", ["migrate", "deploy", "--config", `${CWD}/prisma.schemadiff.config.ts`]],
    ["db push", ["db", "push", "--config", `${CWD}/prisma.schemadiff.config.ts`]],
    ["db execute", ["db", "execute", "--stdin", "--config", `${CWD}/prisma.schemadiff.config.ts`]],
    ["--script 付き", [...buildSchemaDiffCliArgs(CWD).slice(1), "--script"]],
    ["--output 付き", [...buildSchemaDiffCliArgs(CWD).slice(1), "--output", "/tmp/x.sql"]],
    ["--exit-code なし", buildSchemaDiffCliArgs(CWD).slice(1).filter((a) => a !== "--exit-code")],
    ["dotenv_config_path 付き", [...buildSchemaDiffCliArgs(CWD).slice(1), "dotenv_config_path=.env"]],
  ])("argv が固定の diff と違えば（%s）拒否する（ファイルを読まない）", (_label, rest) => {
    const { input, readTestEnv } = readOnlyInput({ argv: ["/usr/local/bin/node", buildSchemaDiffCliArgs(CWD)[0], ...rest] });
    expectReadOnlyRejected(input, "COMMAND_MISMATCH");
    expect(readTestEnv).not.toHaveBeenCalled();
  });

  it("作業ディレクトリが違えば（別のチェックアウトの CLI・設定ファイル）拒否する", () => {
    expectReadOnlyRejected(readOnlyInput({ cwd: "/other/katana-web" }).input, "COMMAND_MISMATCH");
  });

  it.each(["DATABASE_URL", "PRISMA_SCHEMA_ENGINE_BINARY", "PRISMA_MIGRATION_ENGINE_BINARY", "DEBUG", "FORCE_PANIC_SCHEMA_ENGINE", "KATANA_TEST_RO_DATABASE_URL", "npm_config_userconfig", "PGHOST"])(
    "許可リストにない環境変数 %s があれば拒否する（名前だけを表示する）",
    (key) => {
      const error = expectReadOnlyRejected(readOnlyInput({ env: { [key]: RO_URL } }).input, "ENV_NOT_ALLOWED");
      expect(error.message).toContain(key);
    },
  );

  it.each([
    ["CHECKPOINT_DISABLE", undefined],
    ["CHECKPOINT_DISABLE", "0"],
    ["CI", "false"],
    ["RUST_LOG", "info"],
    ["RUST_LOG", "debug"],
    ["RUST_BACKTRACE", "1"],
  ])("固定の値でなければ拒否する（%s=%j）", (key, value) => {
    expectReadOnlyRejected(readOnlyInput({ env: { [key]: value } }).input, "ENV_NOT_FIXED");
  });

  it(".env.test・.env.test.readonly がなければ拒否する", () => {
    expectReadOnlyRejected(readOnlyInput({ testEnv: undefined }).input, "TEST_ENV_MISSING");
    expectReadOnlyRejected(readOnlyInput({ roEnv: undefined }).input, "READ_ONLY_ENV_MISSING");
  });

  it.each([
    ["katana_test_user", RO_URL.replace("katana_test_ro", "katana_test_user"), "USER_NOT_ALLOWED"],
    ["開発用DB", DEV_URL, "PORT_NOT_ALLOWED"],
    ["ほかのホスト", RO_URL.replace("127.0.0.1", "db.example.com"), "HOST_NOT_ALLOWED"],
    ["?schema= 付き", `${RO_URL}?schema=other`, "QUERY_NOT_ALLOWED"],
  ])(".env.test.readonly の URL が %s なら拒否する", (_label, url, targetCode) => {
    const roEnv = { KATANA_TEST_RO_DATABASE_URL: url, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD };
    expectReadOnlyRejected(readOnlyInput({ roEnv, env: { [SCHEMA_DIFF_RO_URL_SHA256_ENV]: schemaDiffUrlSha256(url) } }).input, "READ_ONLY_TARGET_REJECTED", targetCode);
  });

  it("katana_test_ro の認証情報が不正なら拒否する（パスワードの使い回し・短い・余分なキー）", () => {
    const reused = { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, `${PASSWORD}_0123456789abcdefghij`), KATANA_TEST_DB_RO_PASSWORD: `${PASSWORD}_0123456789abcdefghij` };
    const reusedInput = readOnlyInput({ roEnv: reused, testEnv: { ...testEnvFor(TEST_URL.replace(PASSWORD, reused.KATANA_TEST_DB_RO_PASSWORD)), KATANA_TEST_DB_PASSWORD: reused.KATANA_TEST_DB_RO_PASSWORD } }).input;
    expectReadOnlyRejected(reusedInput, "READ_ONLY_CREDENTIALS_REJECTED", "RO_PASSWORD_REUSED");
    const short = { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, "short_pw"), KATANA_TEST_DB_RO_PASSWORD: "short_pw" };
    expectReadOnlyRejected(readOnlyInput({ roEnv: short }).input, "READ_ONLY_CREDENTIALS_REJECTED", "RO_PASSWORD_TOO_SHORT");
    const extra = { KATANA_TEST_RO_DATABASE_URL: RO_URL, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD, DATABASE_URL: TEST_URL };
    expectReadOnlyRejected(readOnlyInput({ roEnv: extra }).input, "READ_ONLY_CREDENTIALS_REJECTED", "RO_ENV_UNEXPECTED_KEY");
  });

  it(".env.test が不正（開発用DBと同じ接続先・パスワードの不一致）なら拒否する", () => {
    expectReadOnlyRejected(readOnlyInput({ devEnv: { DATABASE_URL: TEST_URL } }).input, "TARGET_REJECTED", "MATCHES_DEVELOPMENT_DATABASE");
    expectReadOnlyRejected(readOnlyInput({ testEnv: { ...testEnvFor(), KATANA_TEST_DB_PASSWORD: "x" } }).input, "CREDENTIALS_REJECTED");
  });

  it("URL の SHA-256 が runner の値と違えば・なければ・形式が違えば拒否する（runner が検証したのと別の URL を使わない）", () => {
    for (const value of [undefined, "", schemaDiffUrlSha256(TEST_URL), schemaDiffUrlSha256(RO_URL).toUpperCase(), "0".repeat(64)]) {
      expectReadOnlyRejected(readOnlyInput({ env: { [SCHEMA_DIFF_RO_URL_SHA256_ENV]: value } }).input, "READ_ONLY_URL_MISMATCH");
    }
  });
});

describe("prisma.schemadiff.config.ts（ソースの静的確認。読み込みはしない）", () => {
  const source = readFileSync(path.resolve(__dirname, "../../prisma.schemadiff.config.ts"), "utf8");
  const codeOnly = source.replace(/^\s*\/\/.*$/gm, "");

  it("dotenv/config を読み込まず、ガードの結果の URL だけを使う。migrations・shadowDatabaseUrl・env() は使わない", () => {
    expect(codeOnly).not.toContain("dotenv");
    expect(codeOnly).toContain("resolvePrismaCliReadOnlyTarget({");
    expect(codeOnly).toContain("url: readOnlyTarget.url,");
    for (const forbidden of ["shadowDatabaseUrl", "migrations", "env(", "DATABASE_URL", "resolvePrismaCliDatabaseTarget"]) expect(codeOnly).not.toContain(forbidden);
    expect(codeOnly.indexOf("resolvePrismaCliReadOnlyTarget({")).toBeLessThan(codeOnly.indexOf("export default defineConfig("));
  });

  it("既存の prisma.config.ts は変えない（開発用・migration 用の経路）", () => {
    const config = readFileSync(path.resolve(__dirname, "../../prisma.config.ts"), "utf8");
    expect(config).not.toContain("resolvePrismaCliReadOnlyTarget");
    expect(config).not.toContain("schemadiff");
  });
});
