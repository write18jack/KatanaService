import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  applicationTablesFromSchema,
  IntegrationDatabaseCheckError,
  type IntegrationDatabaseCheckErrorCode,
  type IntegrationDbClient,
  listMigrationNames,
  TEST_DATABASE_MARKER,
} from "./integrationDatabaseCheck";
import {
  buildTestDbMigrateEnv,
  type ClassifyDatabase,
  createTestDatabaseClassifier,
  createTestDatabaseInspector,
  type InspectDatabase,
  LIVE_DATABASE_DISABLED,
  parseTestDbMigrateArgs,
  READ_ONLY_DATABASE_DISABLED,
  runTestDbMigrate,
  type TestDbMigrateDeps,
  TestDbMigrateError,
  type TestDbMigrateErrorCode,
} from "./testDbMigrate";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { enumNamesFromSchema, type TestDatabasePrivileges, type TestDatabaseState } from "./testDbState";

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
/** migration に必要な権限がすべてある（初期化スクリプトの設計どおり） */
const ALL_PRIVILEGES: TestDatabasePrivileges = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
/** テストDBのコンテナの識別情報（偽の値。実際のコンテナIDではない） */
const DOCKER: TestDbDockerIdentity = {
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  startedAt: "2026-11-06T22:46:49.619782389Z",
  restartCount: 0,
  networkId: "c".repeat(64),
  networkIp: "172.18.0.2",
  volumes: ["0df3f60a", "katana-web_postgres_data"],
  developmentVolume: ["katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data"],
  portPublishers: ["katana-test-db"],
};
/** DB 側の識別情報（コンテナの起動の2秒後に postmaster が起動した） */
const SERVER: TestDatabaseServerIdentity = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-06T22:46:51.123456Z" };

type Fake = {
  deps: TestDbMigrateDeps;
  spawn: Mock<TestDbMigrateDeps["spawn"]>;
  /** 状態の判定（実DBへの接続の代わり） */
  classify: Mock<ClassifyDatabase>;
  /** 読み取り専用の検証モード（--verify）の判定（liveDatabase とは別の偽の関数） */
  verify: Mock<InspectDatabase>;
  /** migration 用の Docker の識別情報の読み取り */
  readDockerIdentity: Mock<() => Promise<TestDbDockerIdentity>>;
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
    /** --verify の判定の結果（呼ばれた順。Error なら throw する）。既定は A */
    verifyStates?: (TestDatabaseState | Error)[];
    readOnlyDisabled?: boolean;
    /** --verify の判定を、偽の関数ではなくこの関数にする（本物の判定と偽のDBクライアントを組み合わせるとき） */
    readOnlyInspector?: InspectDatabase;
    /** 偽の判定が返す権限（既定はすべてあり）。migration 用・--verify 用の両方に使う */
    privileges?: Partial<TestDatabasePrivileges>;
    /** 偽の判定が返す DB の識別情報（呼ばれた順。足りなければ最後の値を使う。既定は SERVER） */
    servers?: TestDatabaseServerIdentity[];
    /** migration 用の Docker の識別情報（呼ばれた順。Error なら throw する。足りなければ最後の値を使う。既定は DOCKER） */
    dockers?: (TestDbDockerIdentity | Error)[];
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
  const verifyStates = [...(overrides.verifyStates ?? [STATE_A])];
  const privileges = { ...ALL_PRIVILEGES, ...overrides.privileges };
  const servers = [...(overrides.servers ?? [SERVER])];
  const nextServer = () => (servers.length > 1 ? (servers.shift() as TestDatabaseServerIdentity) : servers[0]);
  const dockers = [...(overrides.dockers ?? [DOCKER])];
  const readDockerIdentity = vi.fn(async () => {
    calls.push("docker");
    const next = dockers.length > 1 ? dockers.shift() : dockers[0];
    if (next instanceof Error) throw next;
    return next as TestDbDockerIdentity;
  });
  const verify = vi.fn<InspectDatabase>(async (input) => {
    calls.push("verify");
    if (overrides.readOnlyInspector) return overrides.readOnlyInspector(input);
    const next = verifyStates.shift();
    if (next === undefined) throw new Error("unexpected verify call in test");
    if (next instanceof Error) throw next;
    return { state: next, privileges, server: nextServer() };
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
    liveDatabase: overrides.liveDisabled
      ? LIVE_DATABASE_DISABLED
      : { mode: "enabled", inspectDatabase: async (input) => ({ state: await classify(input), privileges, server: nextServer() }), readDockerIdentity },
    readOnlyDatabase: overrides.readOnlyDisabled ? READ_ONLY_DATABASE_DISABLED : { mode: "enabled-read-only", inspectDatabase: verify },
    spawn,
    log: (text) => logs.push(text),
  };
  return { deps, spawn, classify, verify, readDockerIdentity, logs, calls };
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
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.readDockerIdentity).not.toHaveBeenCalled();
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
  it("引数なしは通常実行、--check だけは確認モード、--verify だけは読み取り専用の検証モード", () => {
    expect(parseTestDbMigrateArgs([])).toBe("run");
    expect(parseTestDbMigrateArgs(["--check"])).toBe("check");
    expect(parseTestDbMigrateArgs(["--verify"])).toBe("verify");
  });

  it.each([
    [["--check", "--check"]],
    [["--schema", "x"]],
    [["reset"]],
    [["--", "migrate", "reset"]],
    [["--CHECK"]],
    [["--force"]],
    [["--verify", "--check"]],
    [["--check", "--verify"]],
    [["--verify", "--verify"]],
    [["--verify", "--apply"]],
    [["--verify=true"]],
  ])(
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
      // Docker の識別情報 D1 → DB の判定 F1 → 直前の D2 → Prisma CLI → DB の再確認 F2 → D3
      "docker",
      "classify",
      "docker",
      "spawn",
      "classify",
      "docker",
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

  it("スクリプト（scripts/testdb-migrate.mts）は、migration 用の許可を固定の LIVE_DATABASE_DISABLED にし、接続の部品は --verify の許可の中だけで使う", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    expect(source).toMatch(/^\s*liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(source).not.toMatch(/mode:\s*["']enabled["']/);
    // 許可は引数・環境変数から決めない（liveDatabase に渡す値は定数だけ）
    expect(source.match(/liveDatabase/g)).toHaveLength(1);
    for (const forbidden of ["classifyTestDatabase", '"pg"', "process.env.KATANA_TESTDB", "process.argv.includes"]) {
      expect(source).not.toContain(forbidden);
    }
    // 接続の部品は、import と readOnlyDatabase の中の1か所だけ
    const readOnlyBlock = source.slice(source.indexOf("readOnlyDatabase: {"), source.indexOf("},", source.indexOf("readOnlyDatabase: {")));
    expect(source).not.toContain("createTestDatabaseClassifier");
    for (const part of ["connectTestDatabase", "createTestDatabaseInspector"]) {
      expect(source.match(new RegExp(part, "g"))).toHaveLength(2);
      expect(readOnlyBlock).toContain(part);
    }
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

describe("runTestDbMigrate：読み取り専用の検証モード（--verify）", () => {
  it("A なら、検証の後に読み取り専用の判定を1回だけ行い、Prisma CLI も migration 用の判定も使わずに成功する", async () => {
    const f = fake({ argv: ["--verify"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledWith({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    // 引数・Node の起動オプション → .env.test → .env → 接続先・パスワード・親の環境変数の検証 → 期待値のファイル → 判定、の順
    expect(f.calls).toEqual(["read:.env.test", "read:.env", "exists:prisma/schema.prisma", "exists:prisma/migrations", "verify"]);
    const output = f.logs.join("\n");
    expect(output).toContain("verify mode: read-only check of 127.0.0.1:5434/katana_test as katana_test_user (password hidden)");
    expect(output).toContain(`current_user = session_user = katana_test_user, database comment = "${TEST_DATABASE_MARKER}"; search_path pinned to pg_catalog.`);
    expect(output).toContain("the Prisma CLI was not started; nothing was migrated");
    expect(output).toContain("database state: A (the database is empty; no migrations applied)");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("C なら成功する。schema diff は未検証と表示する", async () => {
    const f = fake({ argv: ["--verify"], verifyStates: [STATE_C] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.logs.join("\n")).toContain("database state: C (all 3 expected migrations are applied and the tables are empty;");
    expect(f.logs.join("\n")).toContain("schema diff not verified, Step 3-12");
  });

  it("B なら、理由を表示して失敗する（Prisma CLI を起動せず、reset・自動復旧もしない）", async () => {
    const f = fake({ argv: ["--verify"], verifyStates: [STATE_B] });
    const error = await expectError(f, "DATABASE_STATE_INCONSISTENT");
    expect(error.message).toContain("Nothing was reset or repaired.");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.logs.join("\n")).toContain("database state: B (partially applied, failed or unexpected objects)\n  - migration history does not match");
  });

  it.each<IntegrationDatabaseCheckErrorCode>([
    "DATABASE_MISMATCH",
    "CURRENT_USER_MISMATCH",
    "SESSION_USER_MISMATCH",
    "MARKER_MISMATCH",
    "SEARCH_PATH_NOT_PINNED",
    "NOT_READ_ONLY",
    "QUERY_FAILED",
    "CONNECT_FAILED",
    "CLOSE_FAILED",
  ])("判定が %s で失敗したら、A・B・C のどれとも扱わずに止まる", async (code) => {
    const f = fake({ argv: ["--verify"], verifyStates: [new IntegrationDatabaseCheckError(code, `detail with ${TEST_URL}`)] });
    const error = await expectError(f, "VERIFY_CHECK_FAILED");
    expect(error.message).toContain(`read-only verification database check failed (${code})`);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.logs).toEqual([]);
  });

  it("想定外の例外は、元のメッセージを表示せずに unknown として止まる", async () => {
    const f = fake({ argv: ["--verify"], verifyStates: [new Error(`boom ${TEST_URL}`)] });
    const error = await expectError(f, "VERIFY_CHECK_FAILED");
    expect(error.message).toContain("(unknown)");
  });

  it("読み取り専用の接続の許可が無効なら、すべての検証の後、接続せずに止まる", async () => {
    const f = fake({ argv: ["--verify"], readOnlyDisabled: true });
    const error = await expectStopped(f, "TESTDB_VERIFY_LIVE_DISABLED");
    expect(error.message).toContain("refusing to connect");
    expect(f.calls.at(-1)).toBe("exists:prisma/migrations");
  });

  it("許可は migration 用と共有しない：migration 用が無効でも --verify は動き、--verify 用が無効なら migration 用の判定も使わない", async () => {
    const liveOff = fake({ argv: ["--verify"], liveDisabled: true });
    await expect(runTestDbMigrate(liveOff.deps)).resolves.toBe(0);
    expect(liveOff.verify).toHaveBeenCalledTimes(1);

    const readOnlyOff = fake({ argv: ["--verify"], readOnlyDisabled: true });
    await expectStopped(readOnlyOff, "TESTDB_VERIFY_LIVE_DISABLED");
    expect(readOnlyOff.classify).not.toHaveBeenCalled();
  });

  it("通常実行モードは、--verify の許可が有効でも、migration 用の許可が無効なら TESTDB_MIGRATION_LIVE_DISABLED で止まる", async () => {
    const f = fake({ liveDisabled: true });
    await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
  });

  it("確認モードは、--verify の許可の状態を表示するだけで接続しない", async () => {
    const enabled = fake({ argv: ["--check"] });
    await expect(runTestDbMigrate(enabled.deps)).resolves.toBe(0);
    expect(enabled.verify).not.toHaveBeenCalled();
    expect(enabled.logs.join("\n")).toContain("read-only verification (--verify): enabled");

    const disabled = fake({ argv: ["--check"], readOnlyDisabled: true });
    await expect(runTestDbMigrate(disabled.deps)).resolves.toBe(0);
    expect(disabled.logs.join("\n")).toContain("read-only verification (--verify): disabled in this build");
  });

  it("Prisma CLI がなくても --verify は動く（Prisma CLI のコマンドを組み立てない）。期待値のファイルがなければ止まる", async () => {
    await expect(runTestDbMigrate(fake({ argv: ["--verify"], missingPaths: ["node_modules/prisma/build/index.js", "prisma.config.ts"] }).deps)).resolves.toBe(0);
    await expectStopped(fake({ argv: ["--verify"], missingPaths: ["prisma/migrations"] }), "REQUIRED_FILE_MISSING");
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbMigrateErrorCode]>([
    ["開発用DBの接続先", { files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } } }, "TARGET_REJECTED"],
    ["別のホスト", { files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: TEST_URL.replace("127.0.0.1", "db.example.com") } } }, "TARGET_REJECTED"],
    ["別のポート", { files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: TEST_URL.replace(":5434/", ":5433/") } } }, "TARGET_REJECTED"],
    ["URL のパスワードの不一致", { files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "other-dummy-pass" } } }, "CREDENTIALS_REJECTED"],
    ["見本のパスワード", { files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin" } } }, "CREDENTIALS_REJECTED"],
    [".env.test がない", { files: { ".env.test": undefined } }, "TEST_ENV_MISSING"],
    ["親のプロセスの PG*", { parentEnv: { PATH: "/usr/bin", PGPASSWORD: "x" } }, "UNSAFE_PARENT_ENV"],
    ["親のプロセスの DOTENV_*", { parentEnv: { PATH: "/usr/bin", DOTENV_CONFIG_PATH: "/tmp/x" } }, "UNSAFE_PARENT_ENV"],
    ["NODE_OPTIONS", { parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    ["Node の起動オプション", { execArgv: ["--import", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
  ])("%s なら、接続する前に止まる", async (_label, overrides, code) => {
    await expectStopped(fake({ ...overrides, argv: ["--verify"] }), code);
  });
});

/** 本物の判定（createTestDatabaseInspector → inspectTestDatabase）に渡す、偽のDBクライアント。実DBには接続しない */
function fakeDatabase(options: {
  state?: "A" | "B" | "C";
  identity?: Record<string, unknown>;
  searchPath?: string;
  /** この文字列を含む SQL で失敗する */
  failOn?: string;
  rollbackFails?: boolean;
  connectFails?: boolean;
  /** 権限の SQL の応答（既定はすべて true） */
  privilegeRows?: Record<string, unknown>[];
  /** 識別情報の SQL の応答（既定は SERVER） */
  serverRows?: Record<string, unknown>[];
} = {}) {
  const schemaSource = readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  const tables = applicationTablesFromSchema(schemaSource);
  const enums = enumNamesFromSchema(schemaSource);
  const migrations = listMigrationNames(path.join(REPO_ROOT, "prisma", "migrations"));
  const state = options.state ?? "A";
  const queries: string[] = [];
  const end = vi.fn(async () => undefined);
  const client: IntegrationDbClient = {
    query: async (sql) => {
      queries.push(sql);
      if (options.failOn !== undefined && sql.includes(options.failOn)) throw Object.assign(new Error(`failed at ${TEST_URL}`), { code: "42501" });
      if (sql === "ROLLBACK" && options.rollbackFails) throw Object.assign(new Error(`rollback failed ${PASSWORD}`), { code: "57P01" });
      if (sql.includes("set_config")) return { rows: [{ searchPath: options.searchPath ?? "pg_catalog" }] };
      if (sql.includes("has_schema_privilege")) return { rows: options.privilegeRows ?? [{ ...ALL_PRIVILEGES }] };
      if (sql.includes("inet_server_addr")) return { rows: options.serverRows ?? [{ ...SERVER }] };
      if (sql.includes("transaction_read_only")) return { rows: [{ transaction_read_only: "on" }] };
      if (sql.includes("current_database() AS database")) {
        return {
          rows: [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432, ...options.identity }],
        };
      }
      if (sql.includes("pg_catalog.pg_operator")) return { rows: [] };
      if (sql.includes("pg_catalog.pg_extension")) return { rows: [{ name: "plpgsql" }] };
      if (sql.includes("pg_catalog.pg_class c")) {
        if (state === "A") return { rows: [] };
        if (state === "B") return { rows: [{ schema: "public", name: "Shop", kind: "r", ownerSchema: null, ownerTable: null }] };
        return { rows: [...tables, "_prisma_migrations"].map((name) => ({ schema: "public", name, kind: "r", ownerSchema: null, ownerTable: null })) };
      }
      if (sql.includes("pg_catalog.pg_type t")) return { rows: state === "C" ? enums.map((name) => ({ schema: "public", name, kind: "e" })) : [] };
      if (sql.includes("pg_catalog.pg_proc p")) return { rows: [] };
      if (sql.includes("pg_catalog.pg_namespace n")) return { rows: [{ name: "public" }] };
      if (sql.includes("_prisma_migrations")) return { rows: migrations.map((name) => ({ name, finished: true, rolledBack: false })) };
      if (sql.includes("SELECT EXISTS")) return { rows: [{ hasRows: false }] };
      return { rows: [] };
    },
    end,
  };
  const connect = vi.fn(async (): Promise<IntegrationDbClient> => {
    if (options.connectFails) throw Object.assign(new Error(`connect ECONNREFUSED ${TEST_URL}`), { code: "ECONNREFUSED" });
    return client;
  });
  return { connect, queries, end, inspector: createTestDatabaseInspector({ root: REPO_ROOT, connect }) };
}

/** DBを変更する SQL がないこと（読み取り専用のトランザクション・SHOW・SELECT・ROLLBACK だけ）。権限の名前の文字列リテラル（'CREATE' など）は除いて調べる */
function expectReadOnlyQueries(queries: readonly string[]) {
  for (const sql of queries) {
    expect(sql.trim()).toMatch(/^(BEGIN READ ONLY|ROLLBACK|SHOW |SELECT )/);
    expect(sql.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMIT|COPY|VACUUM|CALL)\b/i);
  }
  expect(queries).not.toContain("COMMIT");
}

describe("runTestDbMigrate：--verify と本物の判定（偽のDBクライアント。実DBには接続しない）", () => {
  const run = async (db: ReturnType<typeof fakeDatabase>) => {
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector });
    return { f, result: runTestDbMigrate(f.deps) };
  };

  it("正しい本人確認と A：BEGIN READ ONLY → search_path の固定 → 本人確認 → 判定 → ROLLBACK → 接続の解放、の順で、読み取りの SQL だけを使う", async () => {
    const db = fakeDatabase({ state: "A" });
    const { f, result } = await run(db);
    await expect(result).resolves.toBe(0);
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.connect).toHaveBeenCalledWith(TEST_URL);
    expect(db.queries[0]).toBe("BEGIN READ ONLY");
    expect(db.queries[1]).toContain("pg_catalog.set_config('search_path', 'pg_catalog', true)");
    expect(db.queries[2]).toBe("SHOW transaction_read_only");
    expect(db.queries[3]).toContain("current_database() AS database");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expectReadOnlyQueries(db.queries);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.logs.join("\n")).toContain("database state: A");
  });

  it("C：期待する migration がすべて適用済みで、テーブルが空なら成功する（読み取りの SQL だけ）", async () => {
    const db = fakeDatabase({ state: "C" });
    const { f, result } = await run(db);
    await expect(result).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("database state: C");
    expect(db.queries.some((sql) => sql.includes("_prisma_migrations"))).toBe(true);
    expect(db.queries.some((sql) => sql.startsWith("SELECT EXISTS"))).toBe(true);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expectReadOnlyQueries(db.queries);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("B：_prisma_migrations のないテーブルがあれば失敗する（ROLLBACK して接続を閉じる）", async () => {
    const db = fakeDatabase({ state: "B" });
    const { f, result } = await run(db);
    await expect(result).rejects.toMatchObject({ code: "DATABASE_STATE_INCONSISTENT" });
    expect(f.logs.join("\n")).toContain("_prisma_migrations is missing");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, IntegrationDatabaseCheckErrorCode]>([
    ["DB名の不一致", { database: "katana" }, "DATABASE_MISMATCH"],
    ["current_user の不一致", { currentUser: "postgres" }, "CURRENT_USER_MISMATCH"],
    ["session_user の不一致", { sessionUser: "postgres" }, "SESSION_USER_MISMATCH"],
    ["DBのコメントの不一致", { marker: null }, "MARKER_MISMATCH"],
  ])("%s なら、状態の判定に進まずに止まり、ROLLBACK して接続を閉じる", async (_label, identity, code) => {
    const db = fakeDatabase({ state: "A", identity });
    const { f, result } = await run(db);
    await expect(result).rejects.toMatchObject({ code: "VERIFY_CHECK_FAILED" });
    await result.catch((error: Error) => expect(error.message).toContain(`(${code})`));
    expect(db.queries.some((sql) => sql.includes("pg_catalog.pg_class c"))).toBe(false);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(f.logs).toEqual([]);
  });

  it("search_path を固定できなければ、本人確認に進まずに止まる", async () => {
    const db = fakeDatabase({ searchPath: "public, pg_catalog" });
    const { result } = await run(db);
    await expect(result).rejects.toThrow("(SEARCH_PATH_NOT_PINNED)");
    expect(db.queries.some((sql) => sql.includes("current_database()"))).toBe(false);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("SQL が失敗したら止まり、ドライバのメッセージ（接続URL）を表示しない", async () => {
    const db = fakeDatabase({ failOn: "pg_catalog.pg_class c" });
    const { f, result } = await run(db);
    const error = await result.catch((e: Error) => e);
    expect(error).toMatchObject({ code: "VERIFY_CHECK_FAILED" });
    expect((error as Error).message).toContain("(QUERY_FAILED)");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(f.logs).toEqual([]);
  });

  it("接続に失敗したら止まる（クエリは送らず、別の接続先も試さない）", async () => {
    const db = fakeDatabase({ connectFails: true });
    const { result } = await run(db);
    const error = await result.catch((e: Error) => e);
    expect((error as Error).message).toContain("(CONNECT_FAILED)");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.queries).toEqual([]);
  });

  it("ROLLBACK に失敗したら、判定が A でも成功とせずに止まる。接続は閉じる", async () => {
    const db = fakeDatabase({ state: "A", rollbackFails: true });
    const { f, result } = await run(db);
    const error = await result.catch((e: Error) => e);
    expect((error as Error).message).toContain("(QUERY_FAILED)");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(f.logs).toEqual([]);
  });

  it("接続先の検証に失敗したら、本物の判定でも接続しない", async () => {
    const db = fakeDatabase();
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector, files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } } });
    await expectStopped(f, "TARGET_REJECTED");
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe("migration に必要な権限（Step 3-11D）", () => {
  const LACKING: [string, Partial<TestDatabasePrivileges>, string][] = [
    ["public USAGE", { publicUsage: false }, "publicUsage"],
    ["public CREATE", { publicCreate: false }, "publicCreate"],
    ["DBの所有者", { databaseOwner: false }, "databaseOwner"],
    ["DBの CREATE", { databaseCreate: false }, "databaseCreate"],
  ];

  it("--verify：すべての権限があれば、状態と4つの権限を別々の行で表示して成功する", async () => {
    for (const state of [STATE_A, STATE_C]) {
      const f = fake({ argv: ["--verify"], verifyStates: [state] });
      await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
      const output = f.logs.join("\n");
      expect(output).toContain(`database state: ${state.state}`);
      expect(output).toContain(
        "migration privileges:\n  public USAGE: true\n  public CREATE: true\n  database owner is katana_test_user: true\n  database CREATE: true",
      );
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.classify).not.toHaveBeenCalled();
    }
  });

  it.each(LACKING)("--verify：%s が不足していれば、状態は A のまま表示し、MIGRATION_PRIVILEGES_INSUFFICIENT で失敗する", async (_label, lacking, key) => {
    const f = fake({ argv: ["--verify"], privileges: lacking });
    const error = await expectError(f, "MIGRATION_PRIVILEGES_INSUFFICIENT");
    expect(error.message).toContain(`(${key})`);
    expect(error.message).toContain("Nothing was granted or changed.");
    const output = f.logs.join("\n");
    expect(output).toContain("database state: A (the database is empty; no migrations applied)");
    expect(output).not.toContain("database state: B");
    expect(output).toMatch(/: false$/m);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("--verify：状態 B は、権限が不足していても B として失敗する（権限の不足を B とは扱わず、B の判定も変えない）", async () => {
    const f = fake({ argv: ["--verify"], verifyStates: [STATE_B], privileges: { publicCreate: false } });
    await expectError(f, "DATABASE_STATE_INCONSISTENT");
    expect(f.logs.join("\n")).toContain("public CREATE: false");
  });

  it.each(LACKING)("migration の事前検査：A でも %s が不足していれば、Prisma CLI を起動せずに止まる", async (_label, lacking, key) => {
    const f = fake({ privileges: lacking });
    const error = await expectError(f, "MIGRATION_PRIVILEGES_INSUFFICIENT");
    expect(error.message).toContain(`(${key})`);
    expect(error.message).toContain("the Prisma CLI was not started");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(1);
    expect(f.logs.join("\n")).toContain("state A, but migration privileges are missing:");
  });

  it("migration の事前検査：すべての権限があれば、今までどおり A で migrate deploy に進む（単体テストの偽の許可でだけ）", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("権限の検査を追加しても、スクリプトの migration 用の許可は無効のまま（通常実行モードは接続せずに止まる）", async () => {
    await expectStopped(fake({ liveDisabled: true }), "TESTDB_MIGRATION_LIVE_DISABLED");
    const source = codeOf("scripts/testdb-migrate.mts");
    expect(source).toMatch(/^\s*liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(source).not.toMatch(/mode:\s*["']enabled["']/);
  });

  it("本物の判定と偽のDB：権限が不足していても状態は A と判定され、--verify は不足として失敗する", async () => {
    const db = fakeDatabase({ state: "A", privilegeRows: [{ ...ALL_PRIVILEGES, publicCreate: false }] });
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector });
    await expectError(f, "MIGRATION_PRIVILEGES_INSUFFICIENT");
    expect(f.logs.join("\n")).toContain("database state: A");
    expect(f.logs.join("\n")).toContain("public CREATE: false");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    expectReadOnlyQueries(db.queries);
  });

  it("本物の判定と偽のDB：権限の SQL は本人確認の後、カタログの一覧の前に1回だけ送る", async () => {
    const db = fakeDatabase({ state: "A" });
    await expect(runTestDbMigrate(fake({ argv: ["--verify"], readOnlyInspector: db.inspector }).deps)).resolves.toBe(0);
    const privilegeIndex = db.queries.findIndex((sql) => sql.includes("has_schema_privilege"));
    expect(db.queries.filter((sql) => sql.includes("has_schema_privilege"))).toHaveLength(1);
    expect(privilegeIndex).toBeGreaterThan(db.queries.findIndex((sql) => sql.includes("current_database() AS database")));
    expect(privilegeIndex).toBeLessThan(db.queries.findIndex((sql) => sql.includes("pg_catalog.pg_namespace n")));
  });

  it.each<[string, Parameters<typeof fakeDatabase>[0], string]>([
    ["権限の SQL の失敗", { failOn: "has_schema_privilege" }, "QUERY_FAILED"],
    ["権限の応答が読めない", { privilegeRows: [{ publicUsage: "t" }] }, "PRIVILEGES_UNAVAILABLE"],
    ["本人確認の失敗", { identity: { currentUser: "postgres" } }, "CURRENT_USER_MISMATCH"],
    ["search_path の固定の失敗", { searchPath: "public" }, "SEARCH_PATH_NOT_PINNED"],
  ])("本物の判定と偽のDB：%s なら、状態を表示せず VERIFY_CHECK_FAILED で止まる（生のエラー・秘密情報を出さない）", async (_label, options, code) => {
    const db = fakeDatabase({ state: "A", ...options });
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector });
    const error = await expectError(f, "VERIFY_CHECK_FAILED");
    expect(error.message).toContain(`(${code})`);
    expect(f.logs).toEqual([]);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledTimes(1);
    if (code !== "QUERY_FAILED" && code !== "PRIVILEGES_UNAVAILABLE") {
      expect(db.queries.some((sql) => sql.includes("has_schema_privilege"))).toBe(false);
    }
  });
});

describe("接続先の識別情報と TOCTOU の照合（Step 3-11E）", () => {
  it("--verify：DB の識別情報を、状態・権限とは別の行で表示する（URL・パスワードなし。Docker は読まない）", async () => {
    const f = fake({ argv: ["--verify"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    const output = f.logs.join("\n");
    expect(output).toContain("server identity (a snapshot at this check; it does not pin later connections):");
    expect(output).toContain("  inet_server_addr: 172.18.0.2");
    expect(output).toContain("  inet_server_port: 5432 (inside the container; the host port 5434 cannot be seen from the database)");
    expect(output).toContain("  pg_postmaster_start_time: 2026-11-06T22:46:51.123456Z");
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("--verify：inet_server_port が 5432 でなければ SERVER_IDENTITY_MISMATCH で失敗する（Prisma CLI は起動しない）", async () => {
    const f = fake({ argv: ["--verify"], servers: [{ ...SERVER, serverPort: 5434 }] });
    const error = await expectError(f, "SERVER_IDENTITY_MISMATCH");
    expect(error.message).toContain("server port is not 5432");
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("--verify：inet_server_addr の値は判定に使わない（どのアドレスでも成功）", async () => {
    await expect(runTestDbMigrate(fake({ argv: ["--verify"], servers: [{ ...SERVER, serverAddress: "10.1.2.3" }] }).deps)).resolves.toBe(0);
  });

  it("migration：すべて一致すれば、照合の結果を表示してから migrate deploy に進む（単体テストの偽の許可でだけ）", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.readDockerIdentity).toHaveBeenCalledTimes(3);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.logs.join("\n")).toContain("identity checks passed (container aaaaaaaaaaaa, inet_server_port 5432, inet_server_addr matches the container network address; recorded only)");
  });

  it("migration：inet_server_addr がコンテナの IP と違っても、記録だけで止めない", async () => {
    const f = fake({ servers: [{ ...SERVER, serverAddress: "192.168.65.3" }] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("inet_server_addr does not match the container network address; recorded only");
  });

  it("migration：Docker の検査が失敗したら、DB に接続せずに止まる（コードだけを表示し、生のメッセージは表示しない）", async () => {
    const f = fake({ dockers: [Object.assign(new Error(`docker said ${TEST_URL}`), { code: "DOCKER_IDENTITY_MISMATCH" })] });
    const error = await expectError(f, "DOCKER_IDENTITY_FAILED");
    expect(error.message).toContain("(DOCKER_IDENTITY_MISMATCH)");
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("migration：コードのない Docker の失敗は unknown（元のメッセージは表示しない）", async () => {
    const f = fake({ dockers: [new Error(`raw ${PASSWORD}`)] });
    const error = await expectError(f, "DOCKER_IDENTITY_FAILED");
    expect(error.message).toContain("(unknown)");
  });

  it.each<[string, Partial<TestDatabaseServerIdentity>, string]>([
    ["inet_server_port の不一致", { serverPort: 5434 }, "server port is not 5432"],
    ["DB の起動時刻がコンテナの起動より前（別のサーバー）", { postmasterStartTime: "2026-11-06T22:40:00.000000Z" }, "postmaster start time is outside the container start window"],
    ["DB の起動時刻がコンテナの起動から離れすぎ（サーバーの起動し直し）", { postmasterStartTime: "2026-11-07T01:00:00.000000Z" }, "postmaster start time is outside the container start window"],
  ])("migration：%s なら、Prisma CLI を起動せずに止まる", async (_label, server, reason) => {
    const f = fake({ servers: [{ ...SERVER, ...server }] });
    const error = await expectError(f, "SERVER_IDENTITY_MISMATCH");
    expect(error.message).toContain(reason);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.readDockerIdentity).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<TestDbDockerIdentity>]>([
    ["containerId", { containerId: "d".repeat(64) }],
    ["startedAt", { startedAt: "2026-11-07T00:00:00.000000000Z" }],
    ["restartCount", { restartCount: 1 }],
    ["portPublishers", { portPublishers: ["katana-test-db", "other"] }],
    ["volumes", { volumes: [...DOCKER.volumes, "new-anonymous"] }],
    ["developmentVolume", { developmentVolume: ["katana-web_postgres_data\t2026-11-07T00:00:00Z\tkatana-web\tpostgres_data"] }],
    ["networkIp", { networkIp: "172.18.0.3" }],
  ])("migration：Prisma CLI の直前の Docker の識別情報で %s が変わっていたら、起動せずに止まる", async (key, change) => {
    const f = fake({ dockers: [DOCKER, { ...DOCKER, ...change }] });
    const error = await expectError(f, "DOCKER_IDENTITY_MISMATCH");
    expect(error.message).toContain(`(${key})`);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.classify).toHaveBeenCalledTimes(1);
  });

  it("migration：migration の後に DB のサーバーが変わっていたら（起動時刻）、状態 C でも失敗する", async () => {
    const f = fake({ servers: [SERVER, { ...SERVER, postmasterStartTime: "2026-11-06T22:50:00.000000Z" }] });
    const error = await expectError(f, "POST_MIGRATION_IDENTITY_MISMATCH");
    expect(error.message).toContain("(postmasterStartTime)");
    expect(error.message).toContain("Nothing was reset or repaired.");
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("migration：migration の後に Docker のコンテナが変わっていたら、状態 C でも失敗する", async () => {
    const f = fake({ dockers: [DOCKER, DOCKER, { ...DOCKER, containerId: "e".repeat(64) }] });
    const error = await expectError(f, "POST_MIGRATION_IDENTITY_MISMATCH");
    expect(error.message).toContain("(containerId)");
  });

  it("migration：migration の後の Docker の検査が失敗したら、成功としない", async () => {
    const f = fake({ dockers: [DOCKER, DOCKER, Object.assign(new Error("x"), { code: "DOCKER_COMMAND_FAILED" })] });
    await expectError(f, "DOCKER_IDENTITY_FAILED");
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("migration：状態 B・権限の不足は、識別情報が一致していても今までどおり止まる（Docker は1回だけ読む）", async () => {
    const b = fake({ states: [STATE_B] });
    await expectError(b, "DATABASE_STATE_INCONSISTENT");
    expect(b.readDockerIdentity).toHaveBeenCalledTimes(1);
    const lacking = fake({ privileges: { publicCreate: false } });
    await expectError(lacking, "MIGRATION_PRIVILEGES_INSUFFICIENT");
    expect(lacking.readDockerIdentity).toHaveBeenCalledTimes(1);
    expect(lacking.spawn).not.toHaveBeenCalled();
  });

  it("migration：DB の本人確認・識別 SQL の失敗では、Prisma CLI を起動しない", async () => {
    for (const code of ["CURRENT_USER_MISMATCH", "SERVER_IDENTITY_UNAVAILABLE", "QUERY_FAILED"] as const) {
      const f = fake({ states: [new IntegrationDatabaseCheckError(code, `x ${TEST_URL}`)] });
      const error = await expectError(f, "STATE_CHECK_FAILED");
      expect(error.message).toContain(`(${code})`);
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });

  it("スクリプトの migration 用の許可は無効のまま（Docker の読み取りも、接続も、Prisma CLI もない）", async () => {
    const f = fake({ liveDisabled: true });
    await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
    const source = codeOf("scripts/testdb-migrate.mts");
    expect(source).toMatch(/^\s*liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(source).not.toContain("readTestDbDockerIdentity");
    expect(source).not.toContain("readDockerIdentity");
  });

  it("本物の判定と偽のDB：識別情報の SQL の応答が読めなければ、--verify は VERIFY_CHECK_FAILED（状態を表示しない）", async () => {
    const db = fakeDatabase({ state: "A", serverRows: [{ ...SERVER, serverAddress: null }] });
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector });
    const error = await expectError(f, "VERIFY_CHECK_FAILED");
    expect(error.message).toContain("(SERVER_IDENTITY_UNAVAILABLE)");
    expect(f.logs).toEqual([]);
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("本物の判定と偽のDB：識別情報の SQL が失敗しても、生のエラーを表示しない", async () => {
    const db = fakeDatabase({ state: "A", failOn: "inet_server_addr" });
    const f = fake({ argv: ["--verify"], readOnlyInspector: db.inspector });
    const error = await expectError(f, "VERIFY_CHECK_FAILED");
    expect(error.message).toContain("(QUERY_FAILED)");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
  });
});

describe("--verify の静的な確認（ソース）", () => {
  it("スクリプトは、--verify の許可だけを固定で有効にする（条件分岐・環境変数・引数で切り替えない）", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    const expected = [
      "  readOnlyDatabase: {",
      '    mode: "enabled-read-only",',
      "    inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),",
      "  },",
    ].join("\n");
    expect(source).toContain(expected);
    expect(source.match(/readOnlyDatabase/g)).toHaveLength(1);
    expect(source.match(/enabled-read-only/g)).toHaveLength(1);
    // 環境変数は、検証の対象として parentEnv に渡すだけ（許可の切り替えには使わない）
    expect(source.match(/process\.env/g)).toHaveLength(1);
    expect(source).toMatch(/^\s*parentEnv: process\.env,$/m);
    expect(source).not.toContain("READ_ONLY_DATABASE_DISABLED");
  });

  it("READ_ONLY_DATABASE_DISABLED は変更できず、LIVE_DATABASE_DISABLED とは別の値", () => {
    expect(READ_ONLY_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(READ_ONLY_DATABASE_DISABLED)).toBe(true);
    expect(READ_ONLY_DATABASE_DISABLED).not.toBe(LIVE_DATABASE_DISABLED);
  });

  it("--verify の経路は、Prisma CLI（spawn）・migration 用の許可・Prisma CLI のコマンドを参照しない", () => {
    const source = codeOf("lib/testing/testDbMigrate.ts");
    const start = source.indexOf("async function runReadOnlyVerify(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    for (const forbidden of ["spawn", "liveDatabase", "PRISMA_MIGRATE_COMMAND", "PRISMA_CLI_ENTRY", "migrate deploy", "args"]) {
      expect(body).not.toContain(forbidden);
    }
    // 分岐は、Prisma CLI のコマンドを組み立てる前にある
    expect(source.indexOf('if (mode === "verify") return runReadOnlyVerify(')).toBeLessThan(source.indexOf("const args = [path.join(root, PRISMA_CLI_ENTRY)"));
  });

  it("npm の testdb:verify は、--verify だけを付けてスクリプトを実行する", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:verify"]).toBe("node scripts/testdb-migrate.mts --verify");
    expect(pkg.scripts["testdb:migrate"]).toBe("node scripts/testdb-migrate.mts");
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
