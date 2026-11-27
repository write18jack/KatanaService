import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IntegrationDatabaseCheckError, type IntegrationDbClient } from "./integrationDatabaseCheck";
import {
  INTEGRATION_DATABASE_DISABLED,
  type IntegrationDatabaseAccess,
  type IntegrationGlobalSetupDeps,
  IntegrationSetupError,
  runIntegrationGlobalSetup,
} from "./integrationDatabaseSetup";
import { IntegrationRunnerError } from "./integrationEnv";
import { createTestDatabaseInspector } from "./testDbMigrate";
import type { TestDatabaseInspection, TestDatabaseState } from "./testDbState";

// 統合テストの globalSetup の本体（Step 4-3）の単体テスト。DB・Docker・子プロセスには触れない。
// inspectDatabase は偽の関数、接続は偽のクライアントだけを使う。値はすべてダミー
const PASSWORD = "setup-dummy-pass";
const ADMIN_PASSWORD = "setup-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, "dev-dummy-pass", TEST_URL, DEV_URL, "postgresql://"];
const REPO_ROOT = path.resolve(__dirname, "../..");

const RUNNER_ENV = { PATH: "/usr/bin", NODE_ENV: "test", DATABASE_URL: TEST_URL, KATANA_DB_TEST_MODE: "integration", KATANA_TEST_RUNNER: "script" };
const FILES = {
  testEnv: { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD },
  developmentEnv: { DATABASE_URL: DEV_URL },
};
const ENABLED: IntegrationDatabaseAccess = { mode: "enabled" };

const SERVER = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-08T00:41:30.798895Z" };
const PRIVILEGES = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
const STATE_C: TestDatabaseState = { state: "C", tables: ["Product", "Shop"], migrations: ["20260118115533_init_new_schema"], schemaDiff: "not-verified" };
const STATE_A: TestDatabaseState = { state: "A" };
const STATE_B: TestDatabaseState = { state: "B", reasons: ["tables are not empty: Product, Shop"] };

/** 呼び出しごとに server を複製する（共有の SERVER を書き換えないように） */
const inspection = (state: TestDatabaseState = STATE_C, server = SERVER): TestDatabaseInspection => ({ state, privileges: PRIVILEGES, server: { ...server } });

function deps(overrides: Partial<IntegrationGlobalSetupDeps> & { inspections?: (TestDatabaseInspection | Error)[] } = {}) {
  const queue = [...(overrides.inspections ?? [inspection(), inspection()])];
  const inspectDatabase = vi.fn<IntegrationGlobalSetupDeps["inspectDatabase"]>(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next as TestDatabaseInspection;
  });
  const readFiles = vi.fn(() => FILES);
  const value: IntegrationGlobalSetupDeps = {
    env: RUNNER_ENV,
    readFiles,
    integrationDatabase: ENABLED,
    inspectDatabase,
    ...overrides,
  };
  // inspectDatabase は、overrides で差し替えなかったときの偽の関数（差し替えたときは使わない）
  return { value, inspectDatabase, readFiles };
}

/** 指定したコードで拒否され、メッセージにパスワード・接続URLが含まれないこと */
async function expectSetupError(run: () => Promise<unknown>, code: string): Promise<string> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IntegrationSetupError);
  expect((error as IntegrationSetupError).code).toBe(code);
  const message = String((error as Error).message);
  for (const secret of SECRETS) expect(message).not.toContain(secret);
  return message;
}

describe("第7の固定ゲート INTEGRATION_DATABASE_DISABLED", () => {
  it("無効の値で凍結されていて、書き換えられない", () => {
    expect(INTEGRATION_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(INTEGRATION_DATABASE_DISABLED)).toBe(true);
    expect(() => {
      (INTEGRATION_DATABASE_DISABLED as { mode: string }).mode = "enabled";
    }).toThrow(TypeError);
    expect(INTEGRATION_DATABASE_DISABLED.mode).toBe("disabled");
  });

  it("無効なら INTEGRATION_DATABASE_LIVE_DISABLED で止まり、inspectDatabase（接続）を一度も呼ばない", async () => {
    const { value, inspectDatabase, readFiles } = deps({ integrationDatabase: INTEGRATION_DATABASE_DISABLED });
    const message = await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_DATABASE_LIVE_DISABLED");
    expect(message).toContain("refusing to start integration tests.");
    expect(inspectDatabase).not.toHaveBeenCalled();
    expect(readFiles).toHaveBeenCalledTimes(1);
  });

  it("環境変数をどう設定しても、ゲートは有効にならない", async () => {
    const env = {
      ...RUNNER_ENV,
      INTEGRATION_DATABASE: "enabled",
      INTEGRATION_DATABASE_ENABLED: "1",
      KATANA_INTEGRATION_DATABASE: "enabled",
      KATANA_DB_GATE: "enabled",
      CI: "true",
    };
    const { value, inspectDatabase } = deps({ env, integrationDatabase: INTEGRATION_DATABASE_DISABLED });
    await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_DATABASE_LIVE_DISABLED");
    expect(inspectDatabase).not.toHaveBeenCalled();
  });

  it.each([[{ mode: "ENABLED" }], [{ mode: "enabled " }], [{ mode: "enabled-read-only" }], [{}]])(
    "mode が \"enabled\" と完全に一致しなければ（%j）、無効として扱う",
    async (gate) => {
      const { value, inspectDatabase } = deps({ integrationDatabase: gate as unknown as IntegrationDatabaseAccess });
      await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_DATABASE_LIVE_DISABLED");
      expect(inspectDatabase).not.toHaveBeenCalled();
    },
  );
});

describe("接続前の検証はゲートより前", () => {
  it.each([
    ["runner の目印がない", { ...RUNNER_ENV, KATANA_TEST_RUNNER: undefined }, "RUNNER_MARKER_MISSING"],
    ["DATABASE_URL が .env.test と違う", { ...RUNNER_ENV, DATABASE_URL: TEST_URL.replace(PASSWORD, "other-dummy-pass") }, "DATABASE_URL_MISMATCH"],
    ["接続先が開発用DB", { ...RUNNER_ENV, DATABASE_URL: DEV_URL }, "PORT_NOT_ALLOWED"],
    ["NODE_OPTIONS がある", { ...RUNNER_ENV, NODE_OPTIONS: "--require x" }, "FORBIDDEN_ENV_PRESENT"],
  ])("%s なら、ゲートが有効でも無効でも、接続前の検証のエラーで止まり、接続しない", async (_label, env, code) => {
    for (const gate of [ENABLED, INTEGRATION_DATABASE_DISABLED]) {
      const { value, inspectDatabase } = deps({ env, integrationDatabase: gate });
      const error = await runIntegrationGlobalSetup(value).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrationRunnerError);
      expect(String((error as Error).message)).toContain(`(${code})`);
      for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
      expect(inspectDatabase).not.toHaveBeenCalled();
    }
  });

  it(".env.test がなければ、接続しない", async () => {
    const { value, inspectDatabase } = deps({ readFiles: () => ({ testEnv: undefined, developmentEnv: FILES.developmentEnv }) });
    await expect(runIntegrationGlobalSetup(value)).rejects.toThrow(/TEST_ENV_MISSING/);
    expect(inspectDatabase).not.toHaveBeenCalled();
  });
});

describe("開始前の検査（ゲートが有効なとき。偽の inspectDatabase）", () => {
  it("状態 C で、サーバーのポートが想定どおりなら、teardown を返す。接続は1回で、検証済みの URL だけを渡す", async () => {
    const { value, inspectDatabase } = deps();
    const teardown = await runIntegrationGlobalSetup(value);
    expect(typeof teardown).toBe("function");
    expect(inspectDatabase).toHaveBeenCalledTimes(1);
    expect(inspectDatabase).toHaveBeenCalledWith({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL });
  });

  it.each([
    ["状態 A（migration なし）", STATE_A, "state A"],
    ["状態 B（データが残っている）", STATE_B, "tables are not empty: Product, Shop"],
    ["状態 B（migration の不一致）", { state: "B", reasons: ["migration history does not match"] } as TestDatabaseState, "migration history does not match"],
  ])("%s なら INTEGRATION_STATE_NOT_C で止まり、teardown を返さない", async (_label, state, reason) => {
    const { value, inspectDatabase } = deps({ inspections: [inspection(state)] });
    const message = await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_STATE_NOT_C");
    expect(message).toContain(reason);
    expect(message).toContain("Do not delete rows");
    expect(inspectDatabase).toHaveBeenCalledTimes(1);
  });

  it("想定外の状態の値も、C でなければ拒否する", async () => {
    const { value } = deps({ inspections: [inspection({ state: "D" } as unknown as TestDatabaseState)] });
    await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_STATE_NOT_C");
  });

  it("サーバーの内部ポートが 5432 でなければ INTEGRATION_SERVER_IDENTITY_MISMATCH", async () => {
    const { value } = deps({ inspections: [inspection(STATE_C, { ...SERVER, serverPort: 5433 })] });
    await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_SERVER_IDENTITY_MISMATCH");
  });

  it("検査の失敗は、コードだけを残して INTEGRATION_INSPECTION_FAILED にする（元のメッセージを表示しない）", async () => {
    const leaky = new Error(`connect to ${TEST_URL} failed with ${PASSWORD}`);
    for (const [error, code] of [
      [new IntegrationDatabaseCheckError("CONNECT_FAILED", "could not connect (ECONNREFUSED)."), "CONNECT_FAILED"],
      [new IntegrationDatabaseCheckError("MARKER_MISMATCH", "x"), "MARKER_MISMATCH"],
      [leaky, "unknown"],
    ] as const) {
      const { value } = deps({ inspections: [error] });
      const message = await expectSetupError(() => runIntegrationGlobalSetup(value), "INTEGRATION_INSPECTION_FAILED");
      expect(message).toContain(`(${code})`);
    }
  });
});

describe("teardown（テストの終了後の読み取り専用の再確認）", () => {
  async function teardownWith(after: TestDatabaseInspection | Error) {
    const { value, inspectDatabase } = deps({ inspections: [inspection(), after] });
    const teardown = await runIntegrationGlobalSetup(value);
    return { run: teardown, inspectDatabase };
  }

  it("状態 C のままで、サーバーの識別情報が開始時と完全に一致すれば成功する。同じ接続先をもう一度だけ検査する", async () => {
    const { run, inspectDatabase } = await teardownWith(inspection());
    await expect(run()).resolves.toBeUndefined();
    expect(inspectDatabase).toHaveBeenCalledTimes(2);
    expect(inspectDatabase.mock.calls[1]).toEqual(inspectDatabase.mock.calls[0]);
  });

  it.each([
    ["データが残っている（状態 B）", inspection(STATE_B), "INTEGRATION_TEARDOWN_STATE_NOT_C", "cleanup defect"],
    ["状態 A になっている（同じサーバーで migration が消えた）", inspection(STATE_A), "INTEGRATION_TEARDOWN_STATE_NOT_C", "state A"],
    ["postmaster の起動時刻が変わった（再起動）", inspection(STATE_C, { ...SERVER, postmasterStartTime: "2026-11-23T01:00:00.000000Z" }), "INTEGRATION_TEARDOWN_SERVER_CHANGED", "postmasterStartTime"],
    ["サーバーのアドレスが変わった（コンテナの作り直し）", inspection(STATE_A, { ...SERVER, serverAddress: "172.18.0.9" }), "INTEGRATION_TEARDOWN_SERVER_CHANGED", "serverAddress"],
    ["サーバーのポートが変わった", inspection(STATE_C, { ...SERVER, serverPort: 5433 }), "INTEGRATION_TEARDOWN_SERVER_CHANGED", "serverPort"],
  ])("%s なら失敗する", async (_label, after, code, detail) => {
    const { run } = await teardownWith(after);
    const message = await expectSetupError(run, code);
    expect(message).toContain(detail);
  });

  it("サーバーが変わっていれば、状態より先にそれを報告する", async () => {
    const { run } = await teardownWith(inspection(STATE_B, { ...SERVER, postmasterStartTime: "2026-11-23T01:00:00.000000Z" }));
    await expectSetupError(run, "INTEGRATION_TEARDOWN_SERVER_CHANGED");
  });

  it("再確認の検査の失敗は INTEGRATION_TEARDOWN_INSPECTION_FAILED（復旧・再試行をしない）", async () => {
    const { run, inspectDatabase } = await teardownWith(new IntegrationDatabaseCheckError("CONNECT_FAILED", "x"));
    const message = await expectSetupError(run, "INTEGRATION_TEARDOWN_INSPECTION_FAILED");
    expect(message).toContain("(CONNECT_FAILED)");
    expect(message).toContain("Nothing was changed or repaired.");
    expect(inspectDatabase).toHaveBeenCalledTimes(2);
  });

  it("開始時の識別情報は、検査の結果を後から書き換えられても変わらない（複製して保持する）", async () => {
    const first = inspection();
    const { value } = deps({ inspections: [first, inspection()] });
    const run = await runIntegrationGlobalSetup(value);
    (first.server as { postmasterStartTime: string }).postmasterStartTime = "2026-11-23T01:00:00.000000Z";
    await expect(run()).resolves.toBeUndefined();
  });
});

// globalSetup が渡す実際の検査（createTestDatabaseInspector → inspectTestDatabase → runReadOnlyCheck）に、偽の接続を渡す。
// リポジトリの schema.prisma・prisma/migrations を読むだけで、DBには接続しない
describe("接続の後片付け（実際の inspector と偽のクライアント）", () => {
  function fakeClient(failAt: RegExp | null) {
    const sql: string[] = [];
    const end = vi.fn(async () => undefined);
    const client: IntegrationDbClient = {
      query: async (text) => {
        sql.push(text.trim().split(/\s+/).slice(0, 2).join(" "));
        if (failAt && failAt.test(text)) throw Object.assign(new Error(`boom ${PASSWORD}`), { code: "57P01" });
        if (text.startsWith("SHOW transaction_read_only")) return { rows: [{ transaction_read_only: "on" }] };
        if (text.includes("set_config('search_path'")) return { rows: [{ searchPath: "pg_catalog" }] };
        // 本人確認・権限・サーバーの識別情報は正しい値を返し、状態の判定（カタログの一覧）まで進ませる
        if (text.includes("shobj_description")) {
          return { rows: [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: "katana-test-db", serverPort: 5432 }] };
        }
        if (text.includes("has_schema_privilege")) return { rows: [PRIVILEGES] };
        if (text.includes("inet_server_addr")) return { rows: [SERVER] };
        return { rows: [] };
      },
      end,
    };
    return { client, sql, end };
  }

  async function runWith(connect: (url: string) => Promise<IntegrationDbClient>) {
    const { value } = deps({
      inspectDatabase: (input) => createTestDatabaseInspector({ root: REPO_ROOT, connect })(input),
    });
    return runIntegrationGlobalSetup(value);
  }

  it("接続に失敗したら、クライアントを残さず、INTEGRATION_INSPECTION_FAILED（CONNECT_FAILED）で止まる", async () => {
    const connect = vi.fn(async () => {
      throw Object.assign(new Error(`refused ${TEST_URL}`), { code: "ECONNREFUSED" });
    });
    const message = await expectSetupError(() => runWith(connect), "INTEGRATION_INSPECTION_FAILED");
    expect(message).toContain("(CONNECT_FAILED)");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(TEST_URL);
  });

  it.each([
    ["search_path の固定", /set_config\('search_path'/],
    ["本人確認", /shobj_description/],
    ["状態の判定の途中", /pg_catalog\.pg_class/],
  ])("%s で失敗しても、ROLLBACK して接続を閉じる", async (_label, failAt) => {
    const { client, sql, end } = fakeClient(failAt);
    const message = await expectSetupError(() => runWith(async () => client), "INTEGRATION_INSPECTION_FAILED");
    expect(message).not.toContain("boom");
    expect(sql[0]).toBe("BEGIN READ");
    expect(sql).toContain("ROLLBACK");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("送る SQL は、BEGIN READ ONLY・SELECT・SHOW・ROLLBACK だけ（DBを変更する文はない）", async () => {
    const { client, sql } = fakeClient(/__never__/);
    await runWith(async () => client).catch(() => undefined); // 偽の空の結果なので、どこかで判定に失敗して止まる
    expect(sql.length).toBeGreaterThan(2);
    for (const statement of sql) expect(statement).toMatch(/^(BEGIN READ|SELECT|SHOW|ROLLBACK)\b/);
  });
});

describe("静的検査：本体に、DBを変更する処理・自動の復旧がない", () => {
  const code = readFileSync(path.join(__dirname, "integrationDatabaseSetup.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  /** 文字列リテラルも除いたもの（エラーメッセージの中の語で誤検出しないように） */
  const statements = code.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

  it("SQL・Docker・migration・reset・削除の処理を含まない", () => {
    for (const forbidden of [/\bTRUNCATE\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bINSERT\b/i, /\bUPDATE\b/i, /\breset\b/i, /\bmigrate\b/i, /docker/i, /\bquery\(/, /\bspawn\b/, /\bexec/]) {
      expect(statements, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("inspectDatabase の呼び出しは inspect() の中の1か所だけで、ゲートの確認より後にある", () => {
    expect(code.match(/deps\.inspectDatabase\(/g)).toHaveLength(1);
    const body = code.slice(code.indexOf("export async function runIntegrationGlobalSetup"));
    expect(body.indexOf('if (deps.integrationDatabase.mode !== "enabled") {')).toBeLessThan(body.indexOf("await inspect("));
  });
});
