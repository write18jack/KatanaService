import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIntegrationRuntimeEnv,
  IntegrationRunnerError,
  prepareIntegrationEnv,
  readIntegrationRuntimeFiles,
} from "./integrationEnv";
import { assertIntegrationRuntime } from "../db/testDatabaseGuard";

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

// globalSetup のソースを文字列として読むだけ（import しない。Step 4-1・4-3）。
// Step 4-3 で、本体を lib/testing/integrationDatabaseSetup.ts の runIntegrationGlobalSetup に移し、無条件の throw を第7の固定ゲートに置き換えた。
// 止まることの振る舞いは lib/testing/integrationDatabaseSetup.test.ts、ゲートの行の固定は lib/testing/testDbMigrate.test.ts で確かめる
describe("integrationGlobalSetup の静的検査（R14-1）", () => {
  /** コメントを除いたコード（説明の中の名前で、禁止語の検査が誤検出しないように） */
  const code = (file: string) =>
    readFileSync(path.join(__dirname, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const entry = code("integrationGlobalSetup.ts");
  const core = code("integrationDatabaseSetup.ts");
  const body = core.slice(core.indexOf("export async function runIntegrationGlobalSetup"));

  it("globalSetup は、作業ディレクトリの .env.test・.env を読む関数と process.env を、本体に渡す", () => {
    expect(entry).toContain("    env: process.env,");
    expect(entry).toContain("    readFiles: () => readIntegrationRuntimeFiles(root),");
    expect(entry).toContain("  const root = process.cwd();");
  });

  it("本体は、接続前の検証を1回だけ、ゲートの確認と inspectDatabase の呼び出しより前に行う", () => {
    const guardCall = "assertIntegrationRuntimeEnv(deps.env, files);";
    expect(body.split(guardCall)).toHaveLength(2);
    expect(body.indexOf("const files = deps.readFiles();")).toBeLessThan(body.indexOf(guardCall));
    const gateAt = body.indexOf('if (deps.integrationDatabase.mode !== "enabled") {');
    expect(gateAt).toBeGreaterThan(body.indexOf(guardCall));
    expect(body.indexOf("deps.inspectDatabase")).toBe(-1); // 呼び出しは inspect() の中だけ
    expect(body.indexOf("await inspect(")).toBeGreaterThan(gateAt);
  });

  it("globalSetup・本体とも、古い検証・別の接続経路を使わない", () => {
    for (const source of [entry, core]) {
      for (const forbidden of ["assertIntegrationProcessEnv", "verifyIntegrationDatabase", "classifyTestDatabase", "@/lib/prisma", '"pg"', "child_process"]) {
        expect(source, forbidden).not.toContain(forbidden);
      }
    }
    // 本体は DB ドライバ・接続の部品を読み込まない（globalSetup が渡す）
    for (const forbidden of ["testDbConnection", "connectTestDatabase", "testDbMigrate", "testDbDocker"]) expect(core, forbidden).not.toContain(forbidden);
  });
});

// lib/prisma.ts（ワーカー側。Step 4-2）。lib/prisma.ts は import すると本物の Prisma Client を作るので、読み込まない。
// 検証の中身は、lib/prisma.ts と同じ形の入力で共通の関数を呼んで確かめ、呼び出し方はソースを文字列として確かめる
describe("ワーカー側（lib/prisma.ts）の接続前の検証（R14-1）", () => {
  /** Vitest のワーカーで lib/prisma.ts が見る process.env と同じ形（値はすべてダミー） */
  const WORKER_ENV = {
    PATH: "/usr/bin",
    NODE_ENV: "test",
    VITEST: "true",
    VITEST_WORKER_ID: "1",
    VITEST_POOL_ID: "1",
    DATABASE_URL: TEST_URL,
    KATANA_DB_TEST_MODE: "integration",
    KATANA_TEST_RUNNER: "script",
  };
  const FILES = { testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV };

  /** lib/prisma.ts と同じ形で呼ぶ（testEnv は .env.test、developmentDatabaseUrl は .env の DATABASE_URL） */
  function worker(env: Record<string, string | undefined>, files: { testEnv: Record<string, string | undefined> | undefined; developmentEnv: Record<string, string> | undefined }) {
    return assertIntegrationRuntime({ env, testEnv: files.testEnv, developmentDatabaseUrl: files.developmentEnv?.DATABASE_URL });
  }

  function codeOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      const message = String((error as Error).message);
      for (const secret of SECRETS) expect(message).not.toContain(secret);
      return (error as { code: string }).code;
    }
    return "passed";
  }

  it("runner が作る子プロセスの環境変数（Vitest が足す変数を含む）と同じ .env.test なら通る", () => {
    expect(worker({ ...prepare().childEnv, VITEST: "true", VITEST_WORKER_ID: "1" }, FILES)).toEqual({
      host: "127.0.0.1",
      port: "5434",
      database: "katana_test",
      user: "katana_test_user",
    });
  });

  it.each([
    ["runner の目印がない", { ...WORKER_ENV, KATANA_TEST_RUNNER: undefined }, FILES, "RUNNER_MARKER_MISSING"],
    ["実行モードが integration でない", { ...WORKER_ENV, KATANA_DB_TEST_MODE: "unit" }, FILES, "TEST_MODE_MISSING"],
    [".env.test がない", WORKER_ENV, { testEnv: undefined, developmentEnv: DEVELOPMENT_ENV }, "TEST_ENV_MISSING"],
    ["DATABASE_URL が .env.test と違う", { ...WORKER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "other-dummy-pass") }, FILES, "DATABASE_URL_MISMATCH"],
    ["接続先が開発用DB", { ...WORKER_ENV, DATABASE_URL: DEV_URL }, { testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL }, developmentEnv: DEVELOPMENT_ENV }, "PORT_NOT_ALLOWED"],
    ["DB名が違う", { ...WORKER_ENV, DATABASE_URL: TEST_URL.replace(/\/katana_test$/, "/katana") }, FILES, "DATABASE_NOT_ALLOWED"],
    ["パスワードが URL と違う", WORKER_ENV, { testEnv: { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, developmentEnv: DEVELOPMENT_ENV }, "URL_PASSWORD_MISMATCH"],
    [
      "パスワードが見本の値",
      { ...WORKER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x") },
      {
        testEnv: { DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x"), KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD },
        developmentEnv: DEVELOPMENT_ENV,
      },
      "PASSWORD_PLACEHOLDER",
    ],
    ["管理用とアプリ用のパスワードを共用", WORKER_ENV, { testEnv: { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, developmentEnv: DEVELOPMENT_ENV }, "ADMIN_PASSWORD_SAME_AS_APP"],
    ["NODE_OPTIONS がある", { ...WORKER_ENV, NODE_OPTIONS: "--require x" }, FILES, "FORBIDDEN_ENV_PRESENT"],
    ["PGHOST がある", { ...WORKER_ENV, PGHOST: "db.example.com" }, FILES, "PG_ENV_PRESENT"],
  ])("%s なら拒否し、globalSetup と同じコードになる（条件の一致）", (_label, env, files, code) => {
    expect(codeOf(() => worker(env, files))).toBe(code);
    const message = expectRejected(() => assertIntegrationRuntimeEnv(env, files), code);
    expect(message).toContain(`(${code})`);
  });

  describe("lib/prisma.ts の静的検査", () => {
    const source = readFileSync(path.join(__dirname, "..", "prisma.ts"), "utf8");
    const guardFn = source.slice(source.indexOf("function assertVitestDatabaseAccess"), source.indexOf("\n}\n", source.indexOf("function assertVitestDatabaseAccess")));
    const guardCall = "\nassertVitestDatabaseAccess();\n";

    it("共通の検証関数を、.env.test・.env を読んだ結果と process.env で呼ぶ（古い assertTestDatabaseTarget は呼ばない）", () => {
      expect(source).toContain('import { assertAppDatabaseTarget, assertIntegrationRuntime } from "./db/testDatabaseGuard";');
      expect(guardFn.split("assertIntegrationRuntime({")).toHaveLength(2);
      expect(guardFn).toMatch(/assertIntegrationRuntime\(\{\s*env,\s*testEnv: readEnvFileInCwd\("\.env\.test"\),\s*developmentDatabaseUrl: readEnvFileInCwd\("\.env"\)\?\.DATABASE_URL,\s*\}\);/);
      expect(source).not.toContain("assertTestDatabaseTarget");
    });

    it("検証は、モジュールの本体で、PrismaPg・PrismaClient の生成と既存クライアントの再利用より前に、無条件で1回だけ呼ぶ", () => {
      expect(source.split(guardCall)).toHaveLength(2);
      const callAt = source.indexOf(guardCall);
      for (const later of ["new PrismaPg(", "new PrismaClient(", "globalForPrisma.prisma ||", "const globalForPrisma"]) {
        expect(source.indexOf(later), later).toBeGreaterThan(callAt);
      }
      // 呼び出しの行は、分岐（if・三項演算子・&&）の中にない
      // callAt は guardCall の先頭の改行の位置なので、その次の文字から行末までが呼び出しの行
      const line = source.slice(callAt + 1, source.indexOf("\n", callAt + 1));
      expect(line.trim()).toBe("assertVitestDatabaseAccess();");
    });

    it("単体テストでの拒否と、Vitest 以外での素通りは変わっていない", () => {
      expect(guardFn).toContain("if (!isVitest) return;");
      expect(guardFn).toMatch(/if \(env\.KATANA_DB_TEST_MODE !== "integration" \|\| env\.KATANA_TEST_RUNNER !== "script"\) \{\s*throw new Error\(/);
      expect(guardFn).toContain("The real Prisma Client cannot be loaded in unit tests.");
      // 単体テストの拒否は、ファイルの読み込みと共通の検証より前
      expect(guardFn.indexOf("cannot be loaded in unit tests")).toBeLessThan(guardFn.indexOf("readEnvFileInCwd("));
      expect(guardFn.indexOf("if (!isVitest) return;")).toBeLessThan(guardFn.indexOf("cannot be loaded in unit tests"));
    });

    it("env ファイルの読み込みは作業ディレクトリの .env・.env.test だけで、値を表示しない", () => {
      expect(source).toContain('function readEnvFileInCwd(fileName: ".env" | ".env.test")');
      expect(source).toContain("readFileSync(path.resolve(process.cwd(), fileName)");
      expect(source).not.toMatch(/console\.|process\.stdout|process\.stderr/);
      expect(source).not.toMatch(/\$\{[^}]*(DATABASE_URL|PASSWORD|source|env\[)/);
    });

    // Step 4-13A（P9）：Vitest の外（Next の開発サーバー）で KATANA_DB_TARGET が設定されたときの接続先の検証
    it("KATANA_DB_TARGET の検証を、Vitest の検証の直後に、モジュールの本体で無条件に1回だけ呼び、PrismaPg・PrismaClient の生成より前に置く", () => {
      const call = "\nassertAppDatabaseTargetAccess();\n";
      expect(source.split(call)).toHaveLength(2);
      expect(source).toContain("\nassertVitestDatabaseAccess();\nassertAppDatabaseTargetAccess();\n");
      const callAt = source.indexOf(call);
      for (const later of ["new PrismaPg(", "new PrismaClient(", "globalForPrisma.prisma ||", "const globalForPrisma"]) {
        expect(source.indexOf(later), later).toBeGreaterThan(callAt);
      }
    });

    it("KATANA_DB_TARGET が未設定なら何もせず（ファイルも読まない）、設定されていれば共通の検証関数を .env.test・.env を読んだ結果と process.env で呼ぶ", () => {
      const fn = source.slice(source.indexOf("function assertAppDatabaseTargetAccess"), source.indexOf("\n}\n", source.indexOf("function assertAppDatabaseTargetAccess")));
      const early = "  if (process.env.KATANA_DB_TARGET === undefined) return;";
      expect(fn).toContain(early);
      expect(fn.indexOf(early)).toBeLessThan(fn.indexOf("readEnvFileInCwd("));
      expect(fn).toMatch(/assertAppDatabaseTarget\(\{\s*env: process\.env,\s*testEnv: readEnvFileInCwd\("\.env\.test"\),\s*developmentDatabaseUrl: readEnvFileInCwd\("\.env"\)\?\.DATABASE_URL,\s*\}\);/);
      expect(fn.split("assertAppDatabaseTarget(")).toHaveLength(2);
    });

    it("vitest.config.ts（通常テスト）は、統合テストのモードを無効にしたまま", () => {
      const unitConfig = readFileSync(path.join(__dirname, "..", "..", "vitest.config.ts"), "utf8");
      expect(unitConfig).toContain('KATANA_DB_TEST_MODE: "unit"');
      expect(unitConfig).toContain('"**/*.integration.test.{ts,tsx}"');
    });
  });
});
