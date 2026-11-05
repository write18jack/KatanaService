import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { IntegrationDatabaseCheckError, type IntegrationDbClient, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import {
  buildTestDbMigrateEnv,
  type ClassifyDatabase,
  createTestDatabaseClassifier,
  LIVE_DATABASE_DISABLED,
  parseTestDbMigrateArgs,
  runTestDbMigrate,
  type TestDbMigrateDeps,
  TestDbMigrateError,
  type TestDbMigrateErrorCode,
} from "./testDbMigrate";
import type { TestDatabaseState } from "./testDbState";

// Prisma CLI を起動せず、DBにも接続しない。ファイル・子プロセス・DBの状態の判定は、すべて偽の関数で置き換える
const ROOT = "/fake/katana-web";
const EXEC_PATH = "/fake/bin/node";
const PASSWORD = "migrate-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const ADMIN_PASSWORD = "migrate-dummy-admin";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"];
/** 正しい .env.test（パスワードの2つのキーを含む。R14） */
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };

const REPO_ROOT = path.resolve(__dirname, "../..");
/** ソースからコメントを除く（コメントの中の名前で誤って一致させない。文字列の中の // は扱わない簡易版） */
const codeOf = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

const STATE_A: TestDatabaseState = { state: "A" };
const STATE_C: TestDatabaseState = { state: "C", tables: ["Shop"], migrations: ["m1", "m2", "m3"], schemaDiff: "not-verified" };
const STATE_B: TestDatabaseState = { state: "B", reasons: ["migration history does not match (missing: 5, extra: 0, failed or rolled back: 0, duplicated: no)"] };

type Fake = {
  deps: TestDbMigrateDeps;
  spawn: Mock<TestDbMigrateDeps["spawn"]>;
  /** 状態の判定（実DBへの接続の代わり） */
  classify: Mock<ClassifyDatabase>;
  logs: string[];
  /** 呼ばれた順の記録 */
  calls: string[];
};

function fake(
  overrides: {
    argv?: string[];
    execArgv?: string[];
    parentEnv?: Record<string, string | undefined>;
    files?: Record<string, Record<string, string> | undefined>;
    missingPaths?: string[];
    /** 判定の結果（呼ばれた順。Error なら throw する）。既定は migration の前が A、後が C */
    states?: (TestDatabaseState | Error)[];
    liveDisabled?: boolean;
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const files: Record<string, Record<string, string> | undefined> = {
    ".env.test": GOOD_TEST_ENV,
    ".env": { DATABASE_URL: DEV_URL },
    ...overrides.files,
  };
  const readEnvFile = (absolutePath: string) => {
    const name = path.relative(ROOT, absolutePath);
    calls.push(`read:${name}`);
    return files[name];
  };
  const states = [...(overrides.states ?? [STATE_A, STATE_C])];
  const classify = vi.fn<ClassifyDatabase>(async () => {
    calls.push("classify");
    const next = states.shift();
    if (next === undefined) throw new Error("unexpected classify call in test");
    if (next instanceof Error) throw next;
    return next;
  });
  const spawn = vi.fn<TestDbMigrateDeps["spawn"]>(async () => {
    calls.push("spawn");
    return 0;
  });
  const deps: TestDbMigrateDeps = {
    root: ROOT,
    argv: overrides.argv ?? [],
    execArgv: overrides.execArgv ?? [],
    execPath: EXEC_PATH,
    parentEnv: overrides.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile,
    pathExists: (absolutePath) => {
      calls.push(`exists:${path.relative(ROOT, absolutePath)}`);
      return !(overrides.missingPaths ?? []).includes(path.relative(ROOT, absolutePath));
    },
    liveDatabase: overrides.liveDisabled ? LIVE_DATABASE_DISABLED : { mode: "enabled", classifyDatabase: classify },
    spawn,
    log: (text) => logs.push(text),
  };
  return { deps, spawn, classify, logs, calls };
}

/** 指定したコードで止まり、メッセージ・表示に秘密情報が含まれないこと */
async function expectError(f: Fake, code: TestDbMigrateErrorCode) {
  let caught: unknown;
  try {
    await runTestDbMigrate(f.deps);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TestDbMigrateError);
  expect((caught as TestDbMigrateError).code).toBe(code);
  for (const secret of SECRETS) expect((caught as Error).message).not.toContain(secret);
  for (const line of f.logs) for (const secret of SECRETS) expect(line).not.toContain(secret);
  return caught as Error;
}

/** 指定したコードで止まり、子プロセスも状態の判定（DBへの接続）も呼ばれないこと */
async function expectStopped(f: Fake, code: TestDbMigrateErrorCode) {
  const error = await expectError(f, code);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.classify).not.toHaveBeenCalled();
  return error;
}

const EXPECTED_ARGS = [
  path.join(ROOT, "node_modules/prisma/build/index.js"),
  "migrate",
  "deploy",
  "--config",
  path.join(ROOT, "prisma.config.ts"),
];

describe("parseTestDbMigrateArgs", () => {
  it("引数なしは通常実行、--check だけは確認モード", () => {
    expect(parseTestDbMigrateArgs([])).toBe("run");
    expect(parseTestDbMigrateArgs(["--check"])).toBe("check");
  });

  it.each([[["--check", "--check"]], [["--schema", "x"]], [["reset"]], [["--", "migrate", "reset"]], [["--CHECK"]], [["--force"]]])(
    "%j は拒否する（Prisma CLI へ引数を渡さない）",
    (args) => {
      expect(() => parseTestDbMigrateArgs(args)).toThrow(TestDbMigrateError);
    },
  );
});

describe("runTestDbMigrate：通常実行モード（A・B・C）", () => {
  it("A なら、検証の後に固定のコマンドで migrate deploy を1回だけ起動し、別の判定で C を確かめて成功する", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual([
      "read:.env.test",
      "read:.env",
      "exists:node_modules/prisma/build/index.js",
      "exists:prisma.config.ts",
      "exists:prisma/schema.prisma",
      "exists:prisma/migrations",
      "classify",
      "spawn",
      "classify",
    ]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    // 判定は、検証済みの .env.test の URL だけで行う（2回とも同じ値。別のURLには接続し直さない）
    expect(f.classify.mock.calls).toEqual([
      [{ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL }],
      [{ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL }],
    ]);
    const output = f.logs.join("\n");
    expect(output).toContain("post-migration state C");
    expect(output).toContain("schema diff not verified");
    expect(output).not.toMatch(/schema (matches|is identical)/i);
    const [command, args, options] = f.spawn.mock.calls[0];
    expect(command).toBe(EXEC_PATH);
    expect(args).toEqual(EXPECTED_ARGS);
    expect(options).toEqual({
      cwd: ROOT,
      shell: false,
      stdio: "inherit",
      env: { PATH: "/usr/bin", HOME: "/home/u", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" },
    });
  });

  it("B なら、理由を表示して止まり、Prisma CLI を起動しない（reset・自動復旧はしない）", async () => {
    const f = fake({ states: [STATE_B] });
    const error = await expectError(f, "DATABASE_STATE_INCONSISTENT");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(1);
    expect(error.message).toContain("Nothing was reset");
    expect(f.logs.join("\n")).toContain("missing: 5");
  });

  it("C なら、Prisma CLI を起動せずに成功する。schema diff は未検証と表示する", async () => {
    const f = fake({ states: [STATE_C] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(1);
    const output = f.logs.join("\n");
    expect(output).toContain("state C");
    expect(output).toContain("the Prisma CLI was not started");
    expect(output).toContain("schema diff not verified");
  });

  it.each([
    ["接続の失敗", new IntegrationDatabaseCheckError("CONNECT_FAILED", "x"), "CONNECT_FAILED"],
    ["本人確認の失敗（DBのコメント）", new IntegrationDatabaseCheckError("MARKER_MISMATCH", "x"), "MARKER_MISMATCH"],
    ["SQL の失敗", new IntegrationDatabaseCheckError("QUERY_FAILED", "x"), "QUERY_FAILED"],
    ["search_path の固定の失敗", new IntegrationDatabaseCheckError("SEARCH_PATH_NOT_PINNED", "x"), "SEARCH_PATH_NOT_PINNED"],
    ["接続を閉じる処理の失敗", new IntegrationDatabaseCheckError("CLOSE_FAILED", "x"), "CLOSE_FAILED"],
    ["想定外の例外（メッセージに URL を含む）", new Error(`boom ${TEST_URL}`), "unknown"],
  ])("migration の前の判定で%sがあれば、A・B・C のどれとも扱わず、Prisma CLI を起動しない", async (_label, failure, detail) => {
    const f = fake({ states: [failure] });
    const error = await expectError(f, "STATE_CHECK_FAILED");
    expect(error.message).toContain(`(${detail})`);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(1);
  });

  it("migrate deploy が0以外で終われば止まり、migration の後の判定もしない（reset しない）", async () => {
    const f = fake();
    f.spawn.mockResolvedValueOnce(3);
    const error = await expectError(f, "MIGRATION_FAILED");
    expect(error.message).toContain("code 3");
    expect(error.message).toContain("Nothing was reset");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.classify).toHaveBeenCalledTimes(1);
  });

  it("Prisma CLI を起動できなければ止まる（エラーの元のメッセージは表示しない）", async () => {
    const f = fake();
    f.spawn.mockRejectedValueOnce(new Error(`spawn failed ${TEST_URL}`));
    await expectError(f, "MIGRATION_FAILED");
    expect(f.classify).toHaveBeenCalledTimes(1);
  });

  it.each<[string, TestDatabaseState]>([
    ["A のまま", STATE_A],
    ["B", STATE_B],
  ])("migration の後の判定が %s なら失敗する（もう一度 migration・reset はしない）", async (_label, after) => {
    const f = fake({ states: [STATE_A, after] });
    const error = await expectError(f, "POST_MIGRATION_STATE_MISMATCH");
    expect(error.message).toContain(`state ${after.state}`);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.classify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["本人確認の失敗", "DATABASE_MISMATCH"],
    ["カタログの検査の失敗", "QUERY_FAILED"],
    ["接続を閉じる処理の失敗", "CLOSE_FAILED"],
  ])("migration の後の判定で%sがあれば失敗する", async (_label, code) => {
    const f = fake({ states: [STATE_A, new IntegrationDatabaseCheckError(code as never, "x")] });
    const error = await expectError(f, "POST_MIGRATION_CHECK_FAILED");
    expect(error.message).toContain(`(${code})`);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("親の DATABASE_URL・PRISMA_*・KATANA_* は子プロセスに渡さず、検証済みの値だけを使う", async () => {
    const f = fake({
      parentEnv: {
        PATH: "/usr/bin",
        DATABASE_URL: DEV_URL,
        PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/engine",
        KATANA_DB_TARGET: "dev",
        LC_ALL: "C",
      },
    });
    await runTestDbMigrate(f.deps);
    expect(f.spawn.mock.calls[0][2].env).toEqual({ PATH: "/usr/bin", LC_ALL: "C", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
  });

  it.each([
    ["PGHOST", { PGHOST: "db.example.com" }, "PG_ENV_PRESENT"],
    ["PGPASSWORD", { PGPASSWORD: "x" }, "PG_ENV_PRESENT"],
    ["PGOPTIONS", { PGOPTIONS: "-c search_path=public" }, "PG_ENV_PRESENT"],
    ["DOTENV_CONFIG_PATH", { DOTENV_CONFIG_PATH: ".env" }, "DOTENV_ENV_PRESENT"],
  ])("親のプロセスに %s があれば、DBに接続する前に止まる（このプロセスの pg が読むため）", async (_label, extra, guardCode) => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", ...extra } });
    const error = await expectStopped(f, "UNSAFE_PARENT_ENV");
    expect(error.message).toContain(`(${guardCode})`);
    expect(f.calls).toEqual(["read:.env.test", "read:.env"]);
    expect(error.message).not.toContain("db.example.com");
  });
});

describe("runTestDbMigrate：実DBへの接続の許可（強制停止）", () => {
  it("許可が無効なら、すべての検証の後、DBに接続せず Prisma CLI も起動せずに止まる", async () => {
    const f = fake({ liveDisabled: true });
    const error = await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
    expect(error.message).toContain("refusing to connect");
    expect(f.calls.at(-1)).toBe("exists:prisma/migrations");
  });

  it("許可が無効でも、それより前の検証の失敗が先に報告される", async () => {
    await expectStopped(fake({ liveDisabled: true, files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x" } } }), "CREDENTIALS_REJECTED");
    await expectStopped(fake({ liveDisabled: true, parentEnv: { PATH: "/usr/bin", PGUSER: "postgres" } }), "UNSAFE_PARENT_ENV");
  });

  it("LIVE_DATABASE_DISABLED は変更できない", () => {
    expect(LIVE_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(LIVE_DATABASE_DISABLED)).toBe(true);
  });

  it("スクリプト（scripts/testdb-migrate.mts）は、許可を固定の LIVE_DATABASE_DISABLED にし、DBへの接続の部品を読み込まない", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    expect(source).toMatch(/^\s*liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(source).not.toMatch(/mode:\s*["']enabled["']/);
    for (const forbidden of ["testDbConnection", "connectTestDatabase", "createTestDatabaseClassifier", "classifyTestDatabase", '"pg"', "process.env.KATANA_TESTDB"]) {
      expect(source).not.toContain(forbidden);
    }
    // 許可は引数・環境変数から決めない（liveDatabase に渡す値は定数だけ）
    expect(source.match(/liveDatabase/g)).toHaveLength(1);
  });

  it("globalSetup の強制停止は変わっていない（DBへの接続の部品も読み込まない）", () => {
    const source = codeOf("lib/testing/integrationGlobalSetup.ts");
    expect(source).toContain("refusing to start integration tests.");
    expect(source).toMatch(/throw new Error\(/);
    for (const forbidden of ["testDbConnection", "connectTestDatabase", "verifyIntegrationDatabase(", "classifyTestDatabase", '"pg"']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("createTestDatabaseClassifier", () => {
  it("作るときは期待値のファイルを読むだけで接続しない。呼んだときに、検証済みのURLで1回だけ接続する", async () => {
    const connect = vi.fn(async (): Promise<IntegrationDbClient> => ({
      query: async (sql) => {
        if (sql.includes("set_config")) return { rows: [{ searchPath: "pg_catalog" }] };
        if (sql.includes("transaction_read_only")) return { rows: [{ transaction_read_only: "on" }] };
        if (sql.includes("current_database()")) {
          return {
            rows: [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 }],
          };
        }
        if (sql.includes("pg_catalog.pg_operator")) return { rows: [] };
        if (sql.includes("pg_catalog.pg_extension")) return { rows: [{ name: "plpgsql" }] };
        if (sql.includes("pg_catalog.pg_class c") || sql.includes("pg_catalog.pg_type t") || sql.includes("pg_catalog.pg_proc p")) return { rows: [] };
        if (sql.includes("pg_catalog.pg_namespace n")) return { rows: [{ name: "public" }] };
        return { rows: [] };
      },
      end: async () => undefined,
    }));
    const classify = createTestDatabaseClassifier({ root: REPO_ROOT, connect });
    expect(connect).not.toHaveBeenCalled();
    await expect(classify({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL })).resolves.toEqual({ state: "A" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(TEST_URL);
  });

  it("開発用DBのURLを渡されたら、接続せずに拒否する", async () => {
    const connect = vi.fn();
    const classify = createTestDatabaseClassifier({ root: REPO_ROOT, connect });
    await expect(classify({ databaseUrl: DEV_URL, developmentDatabaseUrl: DEV_URL })).rejects.toMatchObject({ code: "TARGET_REJECTED" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("runTestDbMigrate：確認モード", () => {
  it("検証と表示だけを行い、DBの状態の判定（接続）も Prisma CLI も起動しない", async () => {
    const f = fake({ argv: ["--check"], parentEnv: { PATH: "/usr/bin", PRISMA_HIDE_UPDATE_MESSAGE: "1", DATABASE_URL: DEV_URL } });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    const output = f.logs.join("\n");
    expect(output).toContain("check mode");
    expect(output).toContain("verified 127.0.0.1:5434/katana_test as katana_test_user");
    expect(output).toContain("command: node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts (no shell)");
    expect(output).toContain("  DATABASE_URL=(hidden)");
    expect(output).toContain("  KATANA_DB_TARGET=test");
    expect(output).toContain("  PRISMA_HIDE_UPDATE_MESSAGE");
    expect(output).toContain("  DATABASE_URL\n");
    expect(output).toContain("live database access: enabled");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("許可が無効なビルドでは、確認モードでそのことを表示する（確認モード自体は成功する）", async () => {
    const f = fake({ argv: ["--check"], liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("live database access: disabled in this build");
  });

  it("確認モードでも、親のプロセスの PG* は拒否する（通常実行モードと同じ判定）", async () => {
    await expectStopped(fake({ argv: ["--check"], parentEnv: { PATH: "/usr/bin", PGHOST: "x" } }), "UNSAFE_PARENT_ENV");
  });

  it("確認モードでも、検証に失敗すれば止まる", async () => {
    await expectStopped(fake({ argv: ["--check"], files: { ".env.test": { DATABASE_URL: DEV_URL } } }), "TARGET_REJECTED");
  });
});

describe("runTestDbMigrate：停止条件（子プロセスを起動しない）", () => {
  it("不正な引数では、ファイルを読む前に止まる", async () => {
    const f = fake({ argv: ["--check", "--force"] });
    await expectStopped(f, "ARGUMENTS_INVALID");
    expect(f.calls).toEqual([]);
  });

  it("Node の起動オプション（execArgv）があれば、ファイルを読む前に止まる", async () => {
    const f = fake({ execArgv: ["--import", "./x.mjs"] });
    await expectStopped(f, "NODE_EXEC_ARGV_PRESENT");
    expect(f.calls).toEqual([]);
  });

  it("NODE_OPTIONS が設定されていれば、ファイルを読む前に止まる", async () => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require ./x.js" } });
    await expectStopped(f, "NODE_OPTIONS_PRESENT");
    expect(f.calls).toEqual([]);
  });

  it(".env.test がなければ、.env を読まずに止まる", async () => {
    const f = fake({ files: { ".env.test": undefined } });
    await expectStopped(f, "TEST_ENV_MISSING");
    expect(f.calls).toEqual(["read:.env.test"]);
  });

  it.each([
    ["DATABASE_URL がない", undefined, "URL_MISSING"],
    ["開発用DBのURL", DEV_URL, "PORT_NOT_ALLOWED"],
    ["ポート5433", TEST_URL.replace(":5434", ":5433"), "PORT_NOT_ALLOWED"],
    ["DB名が違う", TEST_URL.replace(/\/katana_test$/, "/katana"), "DATABASE_NOT_ALLOWED"],
    ["ユーザー名が違う", TEST_URL.replace("katana_test_user", "katana"), "USER_NOT_ALLOWED"],
    ["パスワードなし", "postgresql://katana_test_user@127.0.0.1:5434/katana_test", "PASSWORD_MISSING"],
    ["ほかのホスト", TEST_URL.replace("127.0.0.1", "10.0.0.5"), "HOST_NOT_ALLOWED"],
    ["クエリパラメータ", `${TEST_URL}?host=/tmp`, "QUERY_NOT_ALLOWED"],
  ])(".env.test の DATABASE_URL が %s なら、コマンドの確認の前に止まる", async (_label, url, guardCode) => {
    const f = fake({ files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: url } as Record<string, string> } });
    const error = await expectStopped(f, "TARGET_REJECTED");
    expect(error.message).toContain(`(${guardCode})`);
    expect(f.calls).toEqual(["read:.env.test", "read:.env"]);
  });

  it.each([
    ["アプリ用のパスワードがない", { KATANA_TEST_DB_PASSWORD: undefined }, "APP_PASSWORD_MISSING"],
    ["アプリ用のパスワードが空", { KATANA_TEST_DB_PASSWORD: "" }, "APP_PASSWORD_MISSING"],
    ["管理用のパスワードがない", { KATANA_TEST_DB_ADMIN_PASSWORD: undefined }, "ADMIN_PASSWORD_MISSING"],
    [
      "見本の値のまま",
      {
        DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_test_password"),
        KATANA_TEST_DB_PASSWORD: "CHANGE_ME_test_password",
        KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password",
      },
      "PASSWORD_PLACEHOLDER",
    ],
    ["URLとアプリ用のパスワードが違う", { KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, "URL_PASSWORD_MISMATCH"],
    ["管理用がアプリ用と同じ", { KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, "ADMIN_PASSWORD_SAME_AS_APP"],
    ["使えない文字", { KATANA_TEST_DB_ADMIN_PASSWORD: "admin pass!" }, "PASSWORD_CHARSET"],
  ])(".env.test の %s なら、コマンドの確認の前に止まる（R14）", async (_label, override, credentialsCode) => {
    const f = fake({ files: { ".env.test": { ...GOOD_TEST_ENV, ...override } as Record<string, string> } });
    const error = await expectStopped(f, "CREDENTIALS_REJECTED");
    expect(error.message).toContain(`(${credentialsCode})`);
    expect(f.calls).toEqual(["read:.env.test", "read:.env"]);
  });

  it("確認モードでも、パスワードの検証に失敗すれば止まる（R14）", async () => {
    const f = fake({ argv: ["--check"], files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "changeme-admin" } } });
    await expectStopped(f, "CREDENTIALS_REJECTED");
  });

  it("パスワードは子プロセスに渡さず、親の同じ名前の変数も使わない（R14）", async () => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", KATANA_TEST_DB_PASSWORD: "parent-pass", KATANA_TEST_DB_ADMIN_PASSWORD: "parent-admin" } });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(f.spawn.mock.calls[0][2].env).toEqual({ PATH: "/usr/bin", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
  });

  it("開発用DBと同じ接続先なら止まる", async () => {
    const error = await expectStopped(fake({ files: { ".env": { DATABASE_URL: TEST_URL } } }), "TARGET_REJECTED");
    expect(error.message).toContain("(MATCHES_DEVELOPMENT_DATABASE)");
  });

  it("Prisma CLI・設定・migration が見つからなければ止まる", async () => {
    for (const missing of ["node_modules/prisma/build/index.js", "prisma.config.ts", "prisma/migrations"]) {
      await expectStopped(fake({ missingPaths: [missing] }), "REQUIRED_FILE_MISSING");
    }
  });
});

describe("buildTestDbMigrateEnv", () => {
  it("許可リストの変数・検証済みの DATABASE_URL・KATANA_DB_TARGET=test だけを含み、落とした変数の名前を返す", () => {
    const { childEnv, droppedKeys } = buildTestDbMigrateEnv(
      { PATH: "/usr/bin", TZ: "UTC", NODE_OPTIONS: "", PGUSER: "u", DOTENV_CONFIG_OVERRIDE: "true", DATABASE_URL: DEV_URL },
      TEST_URL,
    );
    expect(childEnv).toEqual({ PATH: "/usr/bin", TZ: "UTC", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
    expect(droppedKeys).toEqual(["DATABASE_URL", "DOTENV_CONFIG_OVERRIDE", "NODE_OPTIONS", "PGUSER"]);
  });
});
