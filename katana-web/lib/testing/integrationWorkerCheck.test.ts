import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXPECTED_DATABASE, EXPECTED_USER, IntegrationDatabaseCheckError, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import { INTEGRATION_DATABASE_DISABLED, type IntegrationDatabaseAccess, IntegrationSetupError } from "./integrationDatabaseSetup";
import { IntegrationRunnerError } from "./integrationEnv";
import { assertWorkerDatabaseIdentity, type IntegrationWorkerSetupDeps, runIntegrationWorkerSetup, WORKER_IDENTITY_SQL } from "./integrationWorkerCheck";

// 統合テストの setupFiles の本体（Step 4-4）の単体テスト。DB・Prisma・Docker・子プロセスには触れない。
// setupFiles（lib/testing/integrationSetup.ts）は import せず、ソースを文字列として読むだけ。値はすべてダミー
const PASSWORD = "worker-dummy-pass";
const ADMIN_PASSWORD = "worker-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, "dev-dummy-pass", TEST_URL, DEV_URL, "postgresql://"];
const ROOT = path.resolve(__dirname, "../..");

const WORKER_ENV = {
  PATH: "/usr/bin",
  NODE_ENV: "test",
  VITEST: "true",
  VITEST_WORKER_ID: "1",
  DATABASE_URL: TEST_URL,
  KATANA_DB_TEST_MODE: "integration",
  KATANA_TEST_RUNNER: "script",
};
const FILES = {
  testEnv: { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD },
  developmentEnv: { DATABASE_URL: DEV_URL },
};
const ENABLED: IntegrationDatabaseAccess = { mode: "enabled" };
const GOOD_ROW = { database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: "katana-test-db" };

/** 例外のコードと、メッセージにパスワード・接続URLが含まれないこと */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
    return (error as { code?: string }).code ?? "no-code";
  }
  return "passed";
}

describe("assertWorkerDatabaseIdentity（純粋な照合）", () => {
  it("期待値は、globalSetup の本人確認と同じ定数", () => {
    expect([EXPECTED_DATABASE, EXPECTED_USER, TEST_DATABASE_MARKER]).toEqual(["katana_test", "katana_test_user", "katana-test-db"]);
  });

  it("正しい識別情報の1行なら成功する", () => {
    expect(() => assertWorkerDatabaseIdentity([GOOD_ROW])).not.toThrow();
  });

  it.each([
    ["DB名が違う", [{ ...GOOD_ROW, database: "katana" }], "DATABASE_MISMATCH"],
    ["current_user が違う", [{ ...GOOD_ROW, currentUser: "postgres" }], "CURRENT_USER_MISMATCH"],
    ["current_user が読み取り専用ロール", [{ ...GOOD_ROW, currentUser: "katana_test_ro" }], "CURRENT_USER_MISMATCH"],
    ["session_user が違う", [{ ...GOOD_ROW, sessionUser: "postgres" }], "SESSION_USER_MISMATCH"],
    ["DB のコメントが違う", [{ ...GOOD_ROW, marker: "katana-dev-db" }], "MARKER_MISMATCH"],
    ["DB のコメントがない（NULL）", [{ ...GOOD_ROW, marker: null }], "IDENTITY_UNAVAILABLE"],
    ["結果が空", [], "IDENTITY_UNAVAILABLE"],
    ["結果が複数行", [GOOD_ROW, GOOD_ROW], "IDENTITY_UNAVAILABLE"],
    ["必須の項目がない", [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user" }], "IDENTITY_UNAVAILABLE"],
    ["項目が文字列でない", [{ ...GOOD_ROW, database: 1 }], "IDENTITY_UNAVAILABLE"],
    ["行が null", [null], "IDENTITY_UNAVAILABLE"],
    ["結果が配列でない", GOOD_ROW, "IDENTITY_UNAVAILABLE"],
    ["結果が undefined", undefined, "IDENTITY_UNAVAILABLE"],
    ["大文字・小文字だけが違う", [{ ...GOOD_ROW, database: "KATANA_TEST" }], "DATABASE_MISMATCH"],
    ["前後に空白がある", [{ ...GOOD_ROW, marker: " katana-test-db" }], "MARKER_MISMATCH"],
  ])("%s なら拒否する", (_label, rows, code) => {
    let caught: unknown;
    try {
      assertWorkerDatabaseIdentity(rows);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationDatabaseCheckError);
    expect((caught as IntegrationDatabaseCheckError).code).toBe(code);
  });

  it("拒否したときに、実際の値をメッセージに含めない", () => {
    const rows = [{ ...GOOD_ROW, database: "secret_db_name", currentUser: "secret_user" }];
    expect(() => assertWorkerDatabaseIdentity(rows)).toThrow(IntegrationDatabaseCheckError);
    try {
      assertWorkerDatabaseIdentity(rows);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret_db_name");
    }
  });
});

describe("runIntegrationWorkerSetup（偽の queryIdentity）", () => {
  function deps(overrides: Partial<IntegrationWorkerSetupDeps> = {}) {
    const queryIdentity = vi.fn(async (): Promise<unknown> => [GOOD_ROW]);
    const value: IntegrationWorkerSetupDeps = { env: WORKER_ENV, readFiles: () => FILES, integrationDatabase: ENABLED, queryIdentity, ...overrides };
    return { value, queryIdentity };
  }

  it("ゲートが無効なら INTEGRATION_DATABASE_LIVE_DISABLED で止まり、queryIdentity（Prisma の読み込み・SQL）を呼ばない", async () => {
    const { value, queryIdentity } = deps({ integrationDatabase: INTEGRATION_DATABASE_DISABLED });
    const error = await runIntegrationWorkerSetup(value).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationSetupError);
    expect((error as IntegrationSetupError).code).toBe("INTEGRATION_DATABASE_LIVE_DISABLED");
    expect(queryIdentity).not.toHaveBeenCalled();
  });

  it.each([[{ mode: "ENABLED" }], [{ mode: "enabled " }], [{}]])("mode が \"enabled\" と完全に一致しなければ（%j）無効として扱う", async (gate) => {
    const { value, queryIdentity } = deps({ integrationDatabase: gate as unknown as IntegrationDatabaseAccess });
    await expect(runIntegrationWorkerSetup(value)).rejects.toBeInstanceOf(IntegrationSetupError);
    expect(queryIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["runner の目印がない", { ...WORKER_ENV, KATANA_TEST_RUNNER: undefined }, FILES, "RUNNER_MARKER_MISSING"],
    ["DATABASE_URL が .env.test と違う", { ...WORKER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "other-dummy-pass") }, FILES, "DATABASE_URL_MISMATCH"],
    ["接続先が開発用DB", { ...WORKER_ENV, DATABASE_URL: DEV_URL }, FILES, "PORT_NOT_ALLOWED"],
    ["NODE_OPTIONS がある", { ...WORKER_ENV, NODE_OPTIONS: "--require x" }, FILES, "FORBIDDEN_ENV_PRESENT"],
    [".env.test がない", WORKER_ENV, { testEnv: undefined, developmentEnv: FILES.developmentEnv }, "TEST_ENV_MISSING"],
  ])("%s なら、ゲートが有効でも接続前の検証で止まり、queryIdentity を呼ばない", async (_label, env, files, code) => {
    const { value, queryIdentity } = deps({ env, readFiles: () => files });
    const error = await runIntegrationWorkerSetup(value).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationRunnerError);
    expect(String((error as Error).message)).toContain(`(${code})`);
    for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
    expect(queryIdentity).not.toHaveBeenCalled();
  });

  it("ゲートが有効で、識別情報が一致すれば成功する。queryIdentity は1回だけ", async () => {
    const { value, queryIdentity } = deps();
    await expect(runIntegrationWorkerSetup(value)).resolves.toBeUndefined();
    expect(queryIdentity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DB名が違う", [{ ...GOOD_ROW, database: "katana" }], "DATABASE_MISMATCH"],
    ["DB のコメントが違う", [{ ...GOOD_ROW, marker: "x" }], "MARKER_MISMATCH"],
    ["結果が空", [], "IDENTITY_UNAVAILABLE"],
  ])("照合が失敗（%s）したら throw する（後続のテストに進まない）", async (_label, rows, code) => {
    const { value } = deps({ queryIdentity: async () => rows });
    const error = await runIntegrationWorkerSetup(value).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationDatabaseCheckError);
    expect((error as IntegrationDatabaseCheckError).code).toBe(code);
  });

  it("SQL・接続の失敗は QUERY_FAILED にし、表示してよいコードだけを残す（元のメッセージを含めない）", async () => {
    for (const [thrown, code] of [
      [Object.assign(new Error(`Can't reach database server at ${TEST_URL} (${PASSWORD})`), { code: "P1001" }), "P1001"],
      [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "ECONNREFUSED"],
      [new Error(`raw ${TEST_URL}`), "unknown"],
    ] as const) {
      const { value } = deps({ queryIdentity: async () => Promise.reject(thrown) });
      const error = await runIntegrationWorkerSetup(value).catch((e: unknown) => e);
      expect((error as IntegrationDatabaseCheckError).code).toBe("QUERY_FAILED");
      expect(String((error as Error).message)).toContain(`(${code})`);
      expect(codeOf(() => {
        throw error;
      })).toBe("QUERY_FAILED");
    }
  });

  it("queryIdentity が投げた照合のエラーは、そのまま伝える", async () => {
    const { value } = deps({ queryIdentity: async () => Promise.reject(new IntegrationDatabaseCheckError("MARKER_MISMATCH", "x")) });
    await expect(runIntegrationWorkerSetup(value)).rejects.toMatchObject({ code: "MARKER_MISMATCH" });
  });
});

describe("静的検査：setupFiles（lib/testing/integrationSetup.ts。import しない）", () => {
  const raw = readFileSync(path.join(__dirname, "integrationSetup.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("第7の固定ゲートを、globalSetup と同じ無効の定数で渡す（有効にする経路がない）", () => {
    expect(code.match(/^ {2}integrationDatabase: .*$/gm)).toEqual(["  integrationDatabase: INTEGRATION_DATABASE_DISABLED,"]);
    expect(code.match(/INTEGRATION_DATABASE_DISABLED/g)).toHaveLength(2);
    expect(code).toContain('import { INTEGRATION_DATABASE_DISABLED } from "./integrationDatabaseSetup.ts";');
    for (const forbidden of ['"enabled"', "mode:", "process.argv", "||", "&&", "if (", "?"]) expect(code, forbidden).not.toContain(forbidden);
    expect(code.match(/process\.env/g)).toEqual(["process.env"]);
  });

  it("globalSetup と setupFiles のゲートの値は同じ（片方だけを有効にしない）", () => {
    const globalSetup = readFileSync(path.join(__dirname, "integrationGlobalSetup.ts"), "utf8");
    const gateOf = (source: string) => /^\s*integrationDatabase: (\S+),$/m.exec(source)?.[1];
    expect(gateOf(code)).toBe("INTEGRATION_DATABASE_DISABLED");
    expect(gateOf(globalSetup)).toBe(gateOf(code));
  });

  it("@/lib/prisma は静的に import せず、queryIdentity の中で動的 import する（ゲートより前に Prisma を読み込まない）", () => {
    expect(code).not.toMatch(/^import[^\n]*(lib\/prisma|@prisma\/client|"pg")/m);
    expect(code.match(/import\(/g)).toHaveLength(1);
    const queryAt = code.indexOf("  queryIdentity: async () => {");
    expect(queryAt).toBeGreaterThan(code.indexOf("  integrationDatabase: INTEGRATION_DATABASE_DISABLED,"));
    expect(code.indexOf('await import("@/lib/prisma")')).toBeGreaterThan(queryAt);
  });

  it("SQL は $queryRaw の1つの SELECT だけで、参照用の WORKER_IDENTITY_SQL と完全に一致する", () => {
    const templates = [...code.matchAll(/prisma\.\$queryRaw`([^`]*)`/g)].map((m) => m[1]);
    expect(templates).toEqual([WORKER_IDENTITY_SQL]);
    expect(WORKER_IDENTITY_SQL).toMatch(/^SELECT\s/);
    expect(WORKER_IDENTITY_SQL).not.toMatch(/\$\{|;/);
    for (const forbidden of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bCREATE\b/i, /\bGRANT\b/i, /\bset_config\b/i]) {
      expect(WORKER_IDENTITY_SQL, String(forbidden)).not.toMatch(forbidden);
    }
    for (const forbidden of ["$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe", "$transaction", "console.", "process.stdout", "process.stderr"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("SQL の関数・演算子は pg_catalog で修飾している（search_path に依存しない）", () => {
    expect(WORKER_IDENTITY_SQL).toContain("pg_catalog.current_database()");
    expect(WORKER_IDENTITY_SQL).toContain("pg_catalog.shobj_description(");
    expect(WORKER_IDENTITY_SQL).toContain("OPERATOR(pg_catalog.=)");
    expect(WORKER_IDENTITY_SQL).toContain("FROM pg_catalog.pg_database d");
    expect(WORKER_IDENTITY_SQL).not.toMatch(/[^R(]\s=\s/);
  });
});

describe("静的検査：本体（lib/testing/integrationWorkerCheck.ts）", () => {
  const code = readFileSync(path.join(__dirname, "integrationWorkerCheck.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("DB ドライバ・Prisma・Docker・子プロセスを読み込まない", () => {
    for (const forbidden of ["@/lib/prisma", "@prisma/client", '"pg"', "testDbConnection", "child_process", "testDbDocker", "import("]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("接続前の検証 → ゲート → queryIdentity → 照合 の順で、queryIdentity の呼び出しは1か所だけ", () => {
    const body = code.slice(code.indexOf("export async function runIntegrationWorkerSetup"));
    const guardAt = body.indexOf("assertIntegrationRuntimeEnv(deps.env, deps.readFiles());");
    const gateAt = body.indexOf('if (deps.integrationDatabase.mode !== "enabled") {');
    const queryAt = body.indexOf("await deps.queryIdentity()");
    const assertAt = body.indexOf("assertWorkerDatabaseIdentity(rows);");
    expect(guardAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(guardAt);
    expect(queryAt).toBeGreaterThan(gateAt);
    expect(assertAt).toBeGreaterThan(queryAt);
    expect(code.match(/deps\.queryIdentity\(/g)).toHaveLength(1);
  });
});

describe("静的検査：統合テストの設定（vitest.integration.config.ts）と通常テストの設定", () => {
  const config = readFileSync(path.join(ROOT, "vitest.integration.config.ts"), "utf8");
  const unitConfig = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");

  it("globalSetup・setupFiles・bail を設定し、並列実行を無効にしたまま", () => {
    expect(config).toContain('globalSetup: ["./lib/testing/integrationGlobalSetup.ts"],');
    expect(config).toContain('setupFiles: ["./lib/testing/integrationSetup.ts"],');
    expect(config).toMatch(/^\s*bail: 1,$/m);
    expect(config).toMatch(/^\s*fileParallelism: false,$/m);
    expect(config).toMatch(/^\s*maxWorkers: 1,$/m);
    expect(config).toMatch(/^\s*maxConcurrency: 1,$/m);
    expect(config).toContain("sequence: { concurrent: false, shuffle: false },");
    expect(config).toContain('include: ["**/*.integration.test.{ts,tsx}"],');
    expect(config).toContain("envDir: false,");
  });

  it("統合テストの設定は test.env を設定せず、vitest.config.ts を引き継がない（runner の環境変数を上書きしない）", () => {
    // 説明のコメントに mergeConfig の語があるので、コメントを除いたコードで調べる
    const configCode = config.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(configCode).not.toMatch(/^\s*env:/m);
    expect(configCode).not.toMatch(/mergeConfig|from "\.\/vitest\.config/);
  });

  it("通常テストの設定は、統合テストを除外し、統合テストのモードを無効にしたまま（setupFiles・globalSetup なし）", () => {
    expect(unitConfig).toContain('exclude: [...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"],');
    expect(unitConfig).toContain('KATANA_DB_TEST_MODE: "unit",');
    expect(unitConfig).not.toMatch(/setupFiles|globalSetup/);
  });
});
