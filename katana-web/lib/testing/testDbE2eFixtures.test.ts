import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationDbClient } from "./integrationDatabaseCheck";
import {
  assertE2eUserPassword,
  E2E_FIXTURE_DISABLED,
  E2E_FIXTURE_OPERATIONS,
  E2E_IDS,
  E2E_LOGIN_ACCOUNTS,
  type E2eFixtureAccess,
  type E2eFixtureDeps,
  E2eFixtureError,
  isSeededOnly,
  parseE2eFixtureArgs,
  runTestDbE2e,
  seedStatements,
} from "./testDbE2eFixtures";
import type { TestDatabaseInspection, TestDatabaseState } from "./testDbState";

// E2E のテストデータの準備（Step 4-13C）の単体テスト。DB・Docker・子プロセスには触れない。
// 読み取り専用の検査・書き込みの接続・ハッシュ・env ファイルは、すべて偽の関数。値はすべてダミー
const PASSWORD = "e2efix-dummy-pass";
const ADMIN_PASSWORD = "e2efix-dummy-admin";
const E2E_PASSWORD = "e2e-user-dummy-pass-0123";
const FAKE_HASH = "$2b$10$fakefakefakefakefakefuFAKEHASHVALUEforTestsOnly1234";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, E2E_PASSWORD, FAKE_HASH, "dev-dummy-pass", TEST_URL, DEV_URL, "postgresql://"];
const ROOT = "/repo/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const ENABLED: E2eFixtureAccess = { mode: "enabled" };
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const SERVER = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-23T04:18:18.515202Z" };
const PRIVILEGES = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
const STATE_C: TestDatabaseState = { state: "C", tables: ["Shop"], migrations: ["m1"], schemaDiff: "not-verified" };
const STATE_SEEDED: TestDatabaseState = { state: "B", reasons: ["tables are not empty: Category, ImportJob, ImportRow, Product, Shop, SwordEra, User"] };
const STATE_BAD_B: TestDatabaseState = { state: "B", reasons: ["migration history does not match (missing: 1, extra: 0, failed or rolled back: 0, duplicated: no)"] };
const inspection = (state: TestDatabaseState, server = SERVER): TestDatabaseInspection => ({ state, privileges: PRIVILEGES, server: { ...server } });

/** 偽の書き込みの接続。SQL を記録し、RETURNING の行数は既定で1行（rowsFor で変えられる） */
function fakeClient(options: { failAt?: RegExp; rowsFor?: (sql: string) => number; identity?: Record<string, unknown> } = {}) {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const end = vi.fn(async () => undefined);
  const client: IntegrationDbClient = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (options.failAt?.test(sql)) throw Object.assign(new Error(`boom ${PASSWORD}`), { code: "23503" });
      if (sql.includes("set_config('search_path'")) return { rows: [{ searchPath: "pg_catalog" }] };
      if (sql.includes("shobj_description")) {
        return { rows: [options.identity ?? { database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: "katana-test-db" }] };
      }
      if (/RETURNING "id"$/.test(sql)) return { rows: Array.from({ length: options.rowsFor ? options.rowsFor(sql) : 1 }, () => ({ id: "x" })) };
      return { rows: [] };
    },
    end,
  };
  return { client, calls, end };
}

function fake(overrides: Partial<E2eFixtureDeps> & { testEnv?: Record<string, string> | undefined; e2eEnv?: Record<string, string> | undefined; inspections?: TestDatabaseInspection[]; client?: IntegrationDbClient } = {}) {
  const logs: string[] = [];
  const files: Record<string, Record<string, string> | undefined> = {
    [path.join(ROOT, ".env.test")]: "testEnv" in overrides ? overrides.testEnv : GOOD_TEST_ENV,
    [path.join(ROOT, ".env")]: { DATABASE_URL: DEV_URL },
    [path.join(ROOT, ".env.e2e")]: "e2eEnv" in overrides ? overrides.e2eEnv : { KATANA_E2E_USER_PASSWORD: E2E_PASSWORD },
  };
  const queue = [...(overrides.inspections ?? [inspection(STATE_C), inspection(STATE_SEEDED)])];
  const inspectDatabase = vi.fn<E2eFixtureDeps["inspectDatabase"]>(async () => (queue.length > 1 ? queue.shift() : queue[0]) as TestDatabaseInspection);
  const { client, calls, end } = fakeClient();
  const usedClient = overrides.client ?? client;
  const connect = vi.fn<E2eFixtureDeps["connect"]>(async () => usedClient);
  const hashPassword = vi.fn((password: string) => (password === E2E_PASSWORD ? FAKE_HASH : "unexpected"));
  const deps: E2eFixtureDeps = {
    root: ROOT,
    argv: ["--op", "seed", "--apply"],
    execArgv: [],
    parentEnv: { PATH: "/usr/bin" },
    readEnvFile: (filePath) => files[filePath],
    hashPassword,
    fixtures: ENABLED,
    inspectDatabase,
    connect,
    log: (text) => logs.push(text),
    ...overrides,
  };
  return { deps, inspectDatabase, connect, hashPassword, calls, end, logs };
}

async function expectStopped(deps: E2eFixtureDeps, code: string): Promise<E2eFixtureError> {
  const error = await runTestDbE2e(deps).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(E2eFixtureError);
  expect((error as E2eFixtureError).code).toBe(code);
  for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
  return error as E2eFixtureError;
}

describe("9つ目の固定ゲート E2E_FIXTURE_DISABLED", () => {
  it("無効の値で凍結されていて、書き換えられない", () => {
    expect(E2E_FIXTURE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(E2E_FIXTURE_DISABLED)).toBe(true);
    expect(() => {
      (E2E_FIXTURE_DISABLED as { mode: string }).mode = "enabled";
    }).toThrow(TypeError);
  });

  it.each(Object.keys(E2E_FIXTURE_OPERATIONS))("--op %s --apply でも、ゲートが無効なら検査も接続もハッシュもせずに止まる", async (op) => {
    const f = fake({ argv: ["--op", op, "--apply"], fixtures: E2E_FIXTURE_DISABLED });
    await expectStopped(f.deps, "E2E_FIXTURE_LIVE_DISABLED");
    expect(f.inspectDatabase).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.hashPassword).not.toHaveBeenCalled();
  });

  it.each([[{ mode: "ENABLED" }], [{ mode: "enabled " }], [{}]])("mode が \"enabled\" と完全に一致しなければ（%j）、無効として扱う", async (gate) => {
    const f = fake({ fixtures: gate as unknown as E2eFixtureAccess });
    await expectStopped(f.deps, "E2E_FIXTURE_LIVE_DISABLED");
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe("引数と事前の検証", () => {
  it("引数は、なし（一覧）・--op <操作>（予行）・--op <操作> --apply だけ。操作は固定の名前だけ", () => {
    expect(parseE2eFixtureArgs([])).toEqual({ mode: "list" });
    expect(parseE2eFixtureArgs(["--op", "seed"])).toEqual({ mode: "dry-run", operation: "seed" });
    expect(parseE2eFixtureArgs(["--op", "e2e03-delete-user", "--apply"])).toEqual({ mode: "apply", operation: "e2e03-delete-user" });
    for (const args of [["--op"], ["--op", "drop-all"], ["--op", "seed", "--force"], ["--apply"], ["seed"], ["--op", "seed", "--apply", "x"], ["--op", "__proto__"], ["--op", "toString"]]) {
      expect(() => parseE2eFixtureArgs(args), args.join(" ")).toThrow(E2eFixtureError);
    }
  });

  it.each([
    ["Node の起動オプション", { execArgv: ["--require", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["NODE_OPTIONS", { parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    ["親の PGHOST", { parentEnv: { PATH: "/usr/bin", PGHOST: "db.example.com" } }, "UNSAFE_PARENT_ENV"],
    ["親の DOTENV_*", { parentEnv: { PATH: "/usr/bin", DOTENV_CONFIG_PATH: ".env" } }, "UNSAFE_PARENT_ENV"],
    [".env.test がない", { testEnv: undefined }, "TEST_ENV_MISSING"],
    ["接続先が開発用DB", { testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } }, "TARGET_REJECTED"],
    ["見本のパスワード", { testEnv: { DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x"), KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD } }, "CREDENTIALS_REJECTED"],
    [".env.e2e がない（seed）", { e2eEnv: undefined }, "E2E_PASSWORD_MISSING"],
  ])("%s なら、ゲートが有効でも検査・接続の前に止まる", async (_label, override, code) => {
    const f = fake(override);
    await expectStopped(f.deps, code);
    expect(f.inspectDatabase).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["見本の値", { KATANA_E2E_USER_PASSWORD: "CHANGE_ME_e2e_password" }, "E2E_PASSWORD_REJECTED"],
    ["短い", { KATANA_E2E_USER_PASSWORD: "short-pass" }, "E2E_PASSWORD_REJECTED"],
    ["使えない文字", { KATANA_E2E_USER_PASSWORD: "e2e user pass with spaces" }, "E2E_PASSWORD_REJECTED"],
    ["テストDB のパスワードと同じ", { KATANA_E2E_USER_PASSWORD: PASSWORD.padEnd(16, "x") }, "E2E_PASSWORD_REJECTED"],
    ["空", { KATANA_E2E_USER_PASSWORD: "" }, "E2E_PASSWORD_MISSING"],
    ["余計なキー", { KATANA_E2E_USER_PASSWORD: E2E_PASSWORD, OTHER: "x" }, "E2E_PASSWORD_REJECTED"],
  ])(".env.e2e のパスワードが%sなら拒否する", (_label, e2eEnv, code) => {
    const testPasswords = [PASSWORD.padEnd(16, "x"), ADMIN_PASSWORD];
    let caught: unknown;
    try {
      assertE2eUserPassword(e2eEnv, testPasswords);
    } catch (error) {
      caught = error;
    }
    expect((caught as E2eFixtureError).code).toBe(code);
    for (const secret of [...SECRETS, ...Object.values(e2eEnv)].filter((v) => v.length >= 6)) expect(String((caught as Error).message)).not.toContain(secret);
  });

  it("seed 以外の操作は .env.e2e を読まない（ない場合も止まらない）", async () => {
    const f = fake({ argv: ["--op", "e2e01-deactivate-shop-a"], e2eEnv: undefined });
    await expect(runTestDbE2e(f.deps)).resolves.toBe(0);
  });
});

describe("一覧と予行（DB に接続しない）", () => {
  it("引数なしは操作の一覧だけ", async () => {
    const f = fake({ argv: [] });
    await expect(runTestDbE2e(f.deps)).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("e2e06-deactivate-shop-d");
    expect(f.inspectDatabase).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each(Object.keys(E2E_FIXTURE_OPERATIONS))("--op %s（予行）は検証と表示だけで、検査・接続・ハッシュをしない。表示に秘密情報を含めない", async (op) => {
    const f = fake({ argv: ["--op", op], fixtures: E2E_FIXTURE_DISABLED });
    await expect(runTestDbE2e(f.deps)).resolves.toBe(0);
    expect(f.inspectDatabase).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.hashPassword).not.toHaveBeenCalled();
    const output = f.logs.join("\n");
    expect(output).toContain("dry run (--apply was not given): no database connection was made and nothing was changed.");
    expect(output).toContain("fixture gate: disabled in this build");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });
});

describe("--apply（ゲートが有効なとき。偽の検査と偽の接続）", () => {
  it("seed：状態 C を確かめ、1つのトランザクションで固定の SQL を実行し、COMMIT した後に「データがあるだけの B」を確かめる", async () => {
    const f = fake();
    await expect(runTestDbE2e(f.deps)).resolves.toBe(0);
    expect(f.inspectDatabase).toHaveBeenCalledTimes(2);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith(TEST_URL);
    expect(f.hashPassword).toHaveBeenCalledTimes(1);
    const sqls = f.calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("set_config('search_path', 'pg_catalog', true)");
    expect(sqls[2]).toContain("shobj_description");
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
    expect(sqls.slice(3, -1)).toHaveLength(seedStatements(FAKE_HASH).length);
    expect(f.end).toHaveBeenCalledTimes(1);
    // パスワードそのものは SQL にも引数にも入らず、ハッシュだけが入る
    for (const call of f.calls) {
      expect(call.sql).not.toContain(E2E_PASSWORD);
      expect(call.sql).not.toContain(FAKE_HASH);
      expect(JSON.stringify(call.params ?? [])).not.toContain(E2E_PASSWORD);
    }
    expect(f.calls.filter((c) => JSON.stringify(c.params ?? []).includes(FAKE_HASH))).toHaveLength(7);
    expect(f.logs.join("\n")).toContain("rows changed: 20");
    for (const secret of SECRETS) expect(f.logs.join("\n")).not.toContain(secret);
  });

  it.each([
    ["seed なのに、データがある（B）", "seed", inspection(STATE_SEEDED)],
    ["seed なのに、migration が合わない B", "seed", inspection(STATE_BAD_B)],
    ["seed なのに、状態 A", "seed", inspection({ state: "A" })],
    ["変更の操作なのに、空（C）", "e2e01-deactivate-shop-a", inspection(STATE_C)],
    ["変更の操作なのに、migration が合わない B", "e2e04-move-user-to-shop-b", inspection(STATE_BAD_B)],
  ])("%s なら、接続せずに STATE_NOT_ALLOWED", async (_label, op, before) => {
    const f = fake({ argv: ["--op", op, "--apply"], inspections: [before] });
    await expectStopped(f.deps, "STATE_NOT_ALLOWED");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("サーバーの内部ポートが 5432 でなければ、接続せずに止まる", async () => {
    const f = fake({ inspections: [inspection(STATE_C, { ...SERVER, serverPort: 5433 })] });
    await expectStopped(f.deps, "SERVER_IDENTITY_MISMATCH");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each(["e2e01-deactivate-shop-a", "e2e02-activate-shop-a", "e2e03-delete-user", "e2e04-move-user-to-shop-b", "e2e05-demote-admin", "e2e06-deactivate-shop-d"])(
    "%s：「データがあるだけの B」で、SQL を1文だけ実行して COMMIT する",
    async (op) => {
      const f = fake({ argv: ["--op", op, "--apply"], inspections: [inspection(STATE_SEEDED), inspection(STATE_SEEDED)] });
      await expect(runTestDbE2e(f.deps)).resolves.toBe(0);
      const sqls = f.calls.map((c) => c.sql);
      expect(sqls).toHaveLength(5); // BEGIN・search_path・本人確認・SQL 1文・COMMIT
      expect(sqls.at(-1)).toBe("COMMIT");
      expect(f.hashPassword).not.toHaveBeenCalled();
    },
  );

  it("前提の条件が合わず 0 件なら（同じ操作を2回など）、ROLLBACK して UNEXPECTED_ROW_COUNT（変更しない）", async () => {
    const { client, calls, end } = fakeClient({ rowsFor: () => 0 });
    const f = fake({ argv: ["--op", "e2e01-deactivate-shop-a", "--apply"], inspections: [inspection(STATE_SEEDED)], client });
    const error = await expectStopped(f.deps, "UNEXPECTED_ROW_COUNT");
    expect(error.message).toContain("rolled back");
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.map((c) => c.sql)).not.toContain("COMMIT");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SQL が途中で失敗したら、ROLLBACK して WRITE_FAILED（元のメッセージを含めない）", async () => {
    const { client, calls, end } = fakeClient({ failAt: /INSERT INTO "public"\."Product"/ });
    const f = fake({ client });
    const error = await expectStopped(f.deps, "WRITE_FAILED");
    expect(error.message).toContain("(23503)");
    expect(error.message).not.toContain("boom");
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.map((c) => c.sql)).not.toContain("COMMIT");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("書き込みの接続の本人確認が合わなければ、SQL を実行せずに ROLLBACK する", async () => {
    const { client, calls } = fakeClient({ identity: { database: "katana", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: "katana-test-db" } });
    const f = fake({ client });
    await expectStopped(f.deps, "WRITE_FAILED");
    expect(calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
  });

  it("接続できなければ WRITE_FAILED（何も変更しない）", async () => {
    const f = fake();
    f.connect.mockRejectedValueOnce(Object.assign(new Error(`refused ${TEST_URL}`), { code: "ECONNREFUSED" }));
    const error = await expectStopped(f.deps, "WRITE_FAILED");
    expect(error.message).toContain("(ECONNREFUSED)");
  });

  it("事後の検査で、サーバーが変わっていれば POST_CHECK_FAILED（修復しない）", async () => {
    const f = fake({ inspections: [inspection(STATE_C), inspection(STATE_SEEDED, { ...SERVER, postmasterStartTime: "2026-11-24T00:00:00.000000Z" })] });
    const error = await expectStopped(f.deps, "POST_CHECK_FAILED");
    expect(error.message).toContain("nothing was repaired");
  });

  it("事後の検査で、「データがあるだけの B」でなければ POST_CHECK_FAILED", async () => {
    const f = fake({ inspections: [inspection(STATE_C), inspection(STATE_C)] });
    await expectStopped(f.deps, "POST_CHECK_FAILED");
  });
});

describe("固定の SQL とデータの静的検査", () => {
  const allStatements = Object.values(E2E_FIXTURE_OPERATIONS).flatMap((op) => op.statements(FAKE_HASH));

  it("SQL は INSERT・UPDATE・DELETE だけで、すべて public のスキーマで修飾し、RETURNING \"id\" で件数を確かめる", () => {
    for (const s of allStatements) {
      expect(s.sql, s.label).toMatch(/^(INSERT INTO|UPDATE|DELETE FROM) "public"\."[A-Za-z]+"/);
      expect(s.sql, s.label).toMatch(/RETURNING "id"$/);
      expect(s.expectRows, s.label).toBe(1);
      for (const forbidden of [/\bTRUNCATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bGRANT\b/i, /\bCREATE\b/i, /\$\{/, /;/]) expect(s.sql, `${s.label} ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("UPDATE・DELETE は、固定の ID（$1）と今の値の条件で、1行だけを対象にする。DELETE は E2E-03 のユーザー1件だけ", () => {
    const changes = allStatements.filter((s) => /^(UPDATE|DELETE)/.test(s.sql));
    expect(changes).toHaveLength(6);
    for (const s of changes) expect(s.sql, s.label).toMatch(/ WHERE "id" = \$1 AND /);
    const deletes = allStatements.filter((s) => s.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/^DELETE FROM "public"\."User" /);
    expect(deletes[0].params).toEqual([E2E_IDS.userE2e03]);
  });

  it("固定の ID は20個で重複がなく、UUID の形（16進数）", () => {
    const ids = Object.values(E2E_IDS);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("ログインに使うアカウントは example.invalid のメールアドレスだけ（実在のドメインを使わない）", () => {
    for (const account of Object.values(E2E_LOGIN_ACCOUNTS)) expect(account.email).toMatch(/^e2e-[0-9a-z-]+@example\.invalid$/);
    const seedEmails = seedStatements(FAKE_HASH).filter((s) => s.sql.includes('"public"."User"')).map((s) => String(s.params[2]));
    for (const email of seedEmails) expect(email).toMatch(/@example\.invalid$/);
  });

  it("isSeededOnly は、データがあるだけの B だけを真にする", () => {
    expect(isSeededOnly(inspection(STATE_SEEDED))).toBe(true);
    expect(isSeededOnly(inspection(STATE_BAD_B))).toBe(false);
    expect(isSeededOnly(inspection({ state: "B", reasons: [...STATE_SEEDED.state === "B" ? STATE_SEEDED.reasons : [], "x"] }))).toBe(false);
    expect(isSeededOnly(inspection(STATE_C))).toBe(false);
    expect(isSeededOnly(inspection({ state: "A" }))).toBe(false);
  });
});

describe("静的検査：scripts/testdb-e2e.mts と package.json（import しない）", () => {
  const code = readFileSync(path.join(REPO_ROOT, "scripts", "testdb-e2e.mts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // F-01 の E2E（docs/E2E-F01-RUNBOOK.md の4章）のために、承認を得て一時的に有効化。E2E の後、無効の定数の形に戻し、この確認も元に戻す
  it("9つ目の固定ゲートを、固定のリテラル { mode: \"enabled\" } で渡す（一時的に有効。切り替えの経路がない）", () => {
    expect(code.match(/^ {2}fixtures: .*$/gm)).toEqual(['  fixtures: { mode: "enabled" },']);
    // 有効値はこの1か所だけ。無効の定数の import・条件式・環境変数・引数による切り替えがないこと
    expect(code.match(/mode:\s*["']enabled["']/g)).toHaveLength(1);
    expect(code.match(/mode:/g)).toHaveLength(1);
    expect(code).not.toContain("E2E_FIXTURE_DISABLED");
    for (const forbidden of ["process.argv.includes", "process.env.", "process.env[", "? {", "?? {", "|| {", "&& {"]) expect(code, forbidden).not.toContain(forbidden);
  });

  it("接続の部品は、inspectDatabase と connect の行の中だけ。ハッシュは bcryptjs のコスト 10", () => {
    expect(code).toContain("  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),");
    expect(code).toContain("  connect: (databaseUrl) => connectTestDatabase(databaseUrl),");
    expect(code.match(/connectTestDatabase/g)).toHaveLength(3);
    expect(code).toContain("  hashPassword: (password) => bcrypt.hashSync(password, 10),");
    for (const forbidden of ['"pg"', "@prisma/client", "@/lib/prisma", "child_process", "testDbDocker"]) expect(code, forbidden).not.toContain(forbidden);
  });

  it("package.json の testdb:e2e は一覧だけで、--apply を含む script はない", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:e2e"]).toBe("node scripts/testdb-e2e.mts");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("testdb-e2e"))).toEqual(["node scripts/testdb-e2e.mts"]);
    expect(Object.values(pkg.scripts).some((s) => s.includes("--apply"))).toBe(false);
  });
});
