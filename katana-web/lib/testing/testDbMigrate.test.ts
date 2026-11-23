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
  type ReadDockerIdentity,
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

/** scripts/testdb-migrate.mts の migration 用の許可の行（Step 3-12B-4 で無効に戻した。固定の無効値だけ。条件分岐・環境変数・引数なし） */
const SCRIPT_LIVE_DISABLED_LINE = /^ {2}liveDatabase: LIVE_DATABASE_DISABLED,$/m;
/** スクリプトの migration 用の許可が、固定の無効値の1か所だけで、有効値がどこにもないこと */
function expectScriptGateFixedDisabled(source: string) {
  expect(source).toMatch(SCRIPT_LIVE_DISABLED_LINE);
  expect(source.match(/liveDatabase/g)).toHaveLength(1);
  expect(source).not.toMatch(/mode:\s*["']enabled["']/);
  // import の1回と、liveDatabase に渡す1回だけ
  expect(source.match(/LIVE_DATABASE_DISABLED/g)).toHaveLength(2);
}

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
  readDockerIdentity: Mock<ReadDockerIdentity>;
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
  const readDockerIdentity = vi.fn<ReadDockerIdentity>(async () => {
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
    // 既定は --apply（migration の実行の意思表示。許可は liveDatabase で別に与える）
    argv: overrides.argv ?? ["--apply"],
    execArgv: overrides.execArgv ?? [],
    execPath: EXEC_PATH,
    parentEnv: overrides.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile,
    pathExists: (absolutePath) => {
      calls.push(`exists:${path.relative(ROOT, absolutePath)}`);
      return !(overrides.missingPaths ?? []).includes(path.relative(ROOT, absolutePath));
    },
    liveDatabase: overrides.liveDisabled ? LIVE_DATABASE_DISABLED : { mode: "enabled" },
    migrationChecks: {
      readDockerIdentity,
      inspectDatabase: async (input) => ({ state: await classify(input), privileges, server: nextServer() }),
    },
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
  it("引数なしは予行、--apply だけは実行の意思表示、--check だけは確認モード、--verify だけは読み取り専用の検証モード", () => {
    expect(parseTestDbMigrateArgs([])).toBe("dry-run");
    expect(parseTestDbMigrateArgs(["--apply"])).toBe("apply");
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
    [["--apply", "--apply"]],
    [["--apply", "--check"]],
    [["--check", "--apply"]],
    [["--apply", "--verify"]],
    [["--apply=true"]],
    [["--APPLY"]],
    [["apply"]],
    [["--apply", "--force"]],
    [["--apply", "--", "reset"]],
    [["--apply", "--schema", "x"]],
    [["toString"]],
    [["__proto__"]],
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

  it("スクリプト（scripts/testdb-migrate.mts）は、migration 用の許可を固定の LIVE_DATABASE_DISABLED にし（Step 3-12B-4）、接続の部品は --verify の許可と migrationChecks の中だけで使う", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    // 許可は引数・環境変数から決めない（liveDatabase に渡す値は固定のリテラルだけ）
    expectScriptGateFixedDisabled(source);
    for (const forbidden of ["classifyTestDatabase", '"pg"', "process.env.KATANA_TESTDB", "process.argv.includes"]) {
      expect(source).not.toContain(forbidden);
    }
    // 接続の部品は、import と、readOnlyDatabase・migrationChecks の中の各1か所だけ（Step 3-12A）
    const blockOf = (start: string) => source.slice(source.indexOf(start), source.indexOf("},", source.indexOf(start)));
    const readOnlyBlock = blockOf("readOnlyDatabase: {");
    const checksBlock = blockOf("migrationChecks: {");
    expect(source).not.toContain("createTestDatabaseClassifier");
    for (const part of ["connectTestDatabase", "createTestDatabaseInspector"]) {
      expect(source.match(new RegExp(part, "g"))).toHaveLength(3);
      expect(readOnlyBlock).toContain(part);
      expect(checksBlock).toContain(part);
    }
  });

  // Step 4-3：globalSetup の無条件の throw を、第7の固定ゲート（INTEGRATION_DATABASE_DISABLED）に置き換えた。
  // 止まることの振る舞いは lib/testing/integrationDatabaseSetup.test.ts で、偽の部品を使って確かめる
  // Step 4-10：統合テストを1回実行するために、承認を得て、ゲートの行を一時的に固定のリテラル { mode: "enabled" } にした
  // （setupFiles と同じ commit・同じ値）。実行の後、INTEGRATION_DATABASE_DISABLED に戻し、この確認も無効値の形に戻す
  it("globalSetup は第7の固定ゲートを固定のリテラルで渡し（Step 4-10 で一時的に有効）、切り替える経路がない（接続の部品は inspectDatabase の中だけ）", () => {
    const source = codeOf("lib/testing/integrationGlobalSetup.ts");
    // ゲートの行は、固定の有効値のリテラルだけ（条件分岐・環境変数・引数なし）
    expect(source.match(/^ {4}integrationDatabase: .*$/gm)).toEqual(['    integrationDatabase: { mode: "enabled" },']);
    expect(source.match(/mode:\s*["']enabled["']/g)).toHaveLength(1);
    expect(source).not.toContain("INTEGRATION_DATABASE_DISABLED");
    expect(source).toMatch(/import \{[^}]*\brunIntegrationGlobalSetup\b[^}]*\} from "\.\/integrationDatabaseSetup\.ts";/);
    for (const forbidden of ["process.argv", "?", "||", "&&", "if (", "INTEGRATION_DATABASE_ENABLED", "process.env["]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // process.env は env として1か所で渡すだけ（ゲートを環境変数から読まない）
    expect(source.match(/process\.env/g)).toEqual(["process.env"]);
    expect(source).toContain("    env: process.env,");
    // 接続の部品は import と、inspectDatabase の1行の中だけ
    const inspectLine = "    inspectDatabase: (input) => createTestDatabaseInspector({ root, connect: connectTestDatabase })(input),";
    expect(source.split(inspectLine)).toHaveLength(2);
    for (const part of ["connectTestDatabase", "createTestDatabaseInspector"]) expect(source.match(new RegExp(part, "g"))).toHaveLength(2);
    // 古い検証・別の接続経路・DBを変更する処理を使わない
    for (const forbidden of ["verifyIntegrationDatabase", "classifyTestDatabase", "assertIntegrationProcessEnv", '"pg"', "child_process", "@/lib/prisma", "TRUNCATE", "DELETE", "DROP", "reset", "migrate"]) {
      expect(source, forbidden).not.toContain(forbidden);
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
    expect(output).toContain("live database access (migration gate): enabled");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("許可が無効なビルドでは、確認モードでそのことを表示する（確認モード自体は成功する）", async () => {
    const f = fake({ argv: ["--check"], liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("live database access (migration gate): disabled in this build");
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
    expect(error.message).toContain("Nothing was reset or repaired");
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

  it("許可が無効なら、権限の検査より前に接続せずに止まる。スクリプトの許可は固定の無効値（Step 3-12B-4）", async () => {
    await expectStopped(fake({ liveDisabled: true }), "TESTDB_MIGRATION_LIVE_DISABLED");
    expectScriptGateFixedDisabled(codeOf("scripts/testdb-migrate.mts"));
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
    expect(error.message).toContain("Nothing was reset or repaired");
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

  it("許可が無効なら Docker の読み取りも、接続も、Prisma CLI もない。スクリプトの許可は固定の無効値で、Docker の読み取りは migrationChecks の中だけ", async () => {
    const f = fake({ liveDisabled: true });
    await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
    const source = codeOf("scripts/testdb-migrate.mts");
    expectScriptGateFixedDisabled(source);
    // Docker の識別情報の読み取りは、migrationChecks の中の1か所だけ（Step 3-12A。--apply のときだけ呼ばれる）
    expect(source.match(/readTestDbDockerIdentity/g)).toHaveLength(2);
    expect(source.match(/readDockerIdentity:/g)).toHaveLength(1);
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

describe("Step 3-12A：--apply と、migration の照合の接続", () => {
  /** 検証（引数・.env・ファイル）までの呼び出し。ここより後が Docker・DB・Prisma CLI */
  const PRE_CHECKS = [
    "read:.env.test",
    "read:.env",
    "exists:node_modules/prisma/build/index.js",
    "exists:prisma.config.ts",
    "exists:prisma/schema.prisma",
    "exists:prisma/migrations",
  ];
  /** 偽の Prisma CLI に渡された引数が、すべて固定の migrate deploy であること（reset・再実行の引数がない） */
  const expectOnlyDeploy = (f: Fake) => {
    for (const [command, args, options] of f.spawn.mock.calls) {
      expect(command).toBe(EXEC_PATH);
      expect(args).toEqual(EXPECTED_ARGS);
      expect(options.shell).toBe(false);
    }
    expect(f.spawn.mock.calls.length).toBeLessThanOrEqual(1);
  };

  it("--apply なし（予行）は、許可が有効でも Docker・DB・Prisma CLI に触れずに 0 で終わる", async () => {
    const f = fake({ argv: [] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual(PRE_CHECKS);
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    const output = f.logs.join("\n");
    expect(output).toContain("dry run (--apply was not given): nothing was migrated");
    expect(output).toContain("migrations run only with --apply; --apply is a confirmation and does not enable the migration gate by itself");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("--apply なし（予行）は、スクリプトと同じ無効な許可でも 0 で終わり、無効であることを表示する", async () => {
    const f = fake({ argv: [], liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual(PRE_CHECKS);
    expect(f.logs.join("\n")).toContain("live database access (migration gate): disabled in this build");
  });

  it("--apply でも、固定の許可が無効なら Docker を読む前に止まる（--apply は許可を与えない）", async () => {
    const f = fake({ argv: ["--apply"], liveDisabled: true });
    const error = await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
    expect(error.message).toContain("--apply alone does not enable it");
    expect(f.calls).toEqual(PRE_CHECKS);
  });

  it("--apply でも、許可が無効なら、環境変数に何があっても止まる（許可を環境変数から導かない）", async () => {
    const f = fake({ argv: ["--apply"], liveDisabled: true, parentEnv: { PATH: "/usr/bin", KATANA_TESTDB_MIGRATION: "enabled", KATANA_TESTDB_APPLY: "1" } });
    await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
  });

  it("--check は、許可が有効でも Docker・DB・Prisma CLI に触れない", async () => {
    const f = fake({ argv: ["--check"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual(PRE_CHECKS);
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("--verify は、許可が有効でも Prisma CLI・migration 用の照合（Docker・判定）を使わない", async () => {
    const f = fake({ argv: ["--verify"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.verify).toHaveBeenCalledTimes(1);
  });

  it.each([[["--apply", "--check"]], [["--check", "--apply"]], [["--apply", "--verify"]], [["--verify", "--apply"]], [["--apply", "--apply"]], [["--apply", "--force"]], [["--apply=1"]]])(
    "%j は、ファイル・Docker・DB に触れる前に ARGUMENTS_INVALID で止まる",
    async (argv) => {
      const f = fake({ argv });
      await expectStopped(f, "ARGUMENTS_INVALID");
      expect(f.calls).toEqual([]);
    },
  );

  it("成功：D1 → F1 → D2 → Prisma CLI → F2 → D3 の順で、Docker の読み取りには runner と同じ root・parentEnv・readEnvFile を渡す", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(["docker", "classify", "docker", "spawn", "classify", "docker"]);
    for (const [input] of f.readDockerIdentity.mock.calls) {
      expect(input).toEqual({ root: ROOT, parentEnv: f.deps.parentEnv, readEnvFile: f.deps.readEnvFile });
    }
    expectOnlyDeploy(f);
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbMigrateErrorCode, string[]]>([
    ["D1 の取得の失敗", { dockers: [Object.assign(new Error("x"), { code: "DOCKER_CONTEXT_MISMATCH" })] }, "DOCKER_IDENTITY_FAILED", ["docker"]],
    ["F1 の本人確認の失敗", { states: [new IntegrationDatabaseCheckError("MARKER_MISMATCH", "x")] }, "STATE_CHECK_FAILED", ["docker", "classify"]],
    ["F1 の状態 B", { states: [STATE_B] }, "DATABASE_STATE_INCONSISTENT", ["docker", "classify"]],
    ["F1 の権限不足", { privileges: { databaseCreate: false } }, "MIGRATION_PRIVILEGES_INSUFFICIENT", ["docker", "classify"]],
    ["D1・F1 の照合の不一致", { servers: [{ ...SERVER, postmasterStartTime: "2026-11-06T20:00:00.000000Z" }] }, "SERVER_IDENTITY_MISMATCH", ["docker", "classify"]],
    ["D2 の不一致", { dockers: [DOCKER, { ...DOCKER, restartCount: 1 }] }, "DOCKER_IDENTITY_MISMATCH", ["docker", "classify", "docker"]],
    ["D2 の取得の失敗", { dockers: [DOCKER, Object.assign(new Error("x"), { code: "DOCKER_COMMAND_FAILED" })] }, "DOCKER_IDENTITY_FAILED", ["docker", "classify", "docker"]],
  ])("CLI の起動の前の拒否：%s なら、Prisma CLI を起動せずに止まる", async (_label, overrides, code, order) => {
    const f = fake(overrides);
    const error = await expectError(f, code);
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(order);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(error.message).not.toContain("detection after the fact");
  });

  it("Prisma CLI の失敗：部分的な適用の可能性を報告し、再実行・reset・F2・D3 をしない", async () => {
    const f = fake();
    f.spawn.mockImplementationOnce(async () => {
      f.calls.push("spawn");
      return 1;
    });
    const error = await expectError(f, "MIGRATION_FAILED");
    expect(error.message).toContain("may have been partially applied");
    expect(error.message).toContain("Nothing was reset or retried");
    expect(error.message).toContain("The post-migration checks (F2, D3) were not run and the database state is unverified.");
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(["docker", "classify", "docker", "spawn"]);
    expectOnlyDeploy(f);
  });

  it("Prisma CLI を起動できない（偽のプロセスが reject）：生のエラーを表示せず、部分的な適用の可能性を報告する", async () => {
    const f = fake();
    f.spawn.mockImplementationOnce(async () => {
      f.calls.push("spawn");
      throw new Error(`EACCES ${TEST_URL} ${PASSWORD}`);
    });
    const error = await expectError(f, "MIGRATION_FAILED");
    expect(error.message).toContain("may have been partially applied");
    expect(error.message).not.toContain("EACCES");
    expect(error.message).toContain("(F2, D3) were not run");
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(["docker", "classify", "docker", "spawn"]);
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbMigrateErrorCode, string[]]>([
    ["F2 の識別情報の不一致", { servers: [SERVER, { ...SERVER, serverAddress: "172.18.0.9", postmasterStartTime: "2026-11-06T23:00:00.000000Z" }] }, "POST_MIGRATION_IDENTITY_MISMATCH", ["docker", "classify", "docker", "spawn", "classify"]],
    ["F2 の本人確認の失敗", { states: [STATE_A, new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", "x")] }, "POST_MIGRATION_CHECK_FAILED", ["docker", "classify", "docker", "spawn", "classify"]],
    ["D3 の不一致", { dockers: [DOCKER, DOCKER, { ...DOCKER, startedAt: "2026-11-07T00:00:00.000000000Z" }] }, "POST_MIGRATION_IDENTITY_MISMATCH", ["docker", "classify", "docker", "spawn", "classify", "docker"]],
    ["D3 の取得の失敗", { dockers: [DOCKER, DOCKER, Object.assign(new Error("x"), { code: "DOCKER_IDENTITY_MISMATCH" })] }, "DOCKER_IDENTITY_FAILED", ["docker", "classify", "docker", "spawn", "classify", "docker"]],
    ["最終状態が C でない（A のまま）", { states: [STATE_A, STATE_A] }, "POST_MIGRATION_STATE_MISMATCH", ["docker", "classify", "docker", "spawn", "classify", "docker"]],
    ["最終状態が B", { states: [STATE_A, STATE_B] }, "POST_MIGRATION_STATE_MISMATCH", ["docker", "classify", "docker", "spawn", "classify", "docker"]],
  ])("実行後の異常検出：%s は、防止ではなく事後の検出として報告し、再実行・reset をしない", async (_label, overrides, code, order) => {
    const f = fake(overrides);
    const error = await expectError(f, code);
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(order);
    expect(error.message).toContain("detection after the fact, not prevention");
    expect(error.message).toContain("nothing was retried");
    expectOnlyDeploy(f);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("最終状態 C：F1 = F2、D1 = D3 で、C のときだけ成功を表示する", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.logs.at(-1)).toContain("post-migration state C");
  });

  it("D1 の取得の失敗は、元のメッセージ（URL・パスワード）を表示しない", async () => {
    const f = fake({ dockers: [Object.assign(new Error(`${TEST_URL} ${PASSWORD} ${ADMIN_PASSWORD}`), { code: "DOCKER_COMMAND_FAILED" })] });
    const error = await expectError(f, "DOCKER_IDENTITY_FAILED");
    expect(error.message).toContain("(D1) failed (DOCKER_COMMAND_FAILED). The Prisma CLI was not started.");
  });

  it("スクリプトは migrationChecks に本物の関数を渡し、許可は固定の無効値（--apply・環境変数で切り替えない。Step 3-12B-4）", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    const expected = [
      "  migrationChecks: {",
      "    readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),",
      "    inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),",
      "  },",
    ].join("\n");
    expect(source).toContain(expected);
    expectScriptGateFixedDisabled(source);
    expect(source).not.toContain("--apply");
    expect(source).not.toContain("scripts/testdb.mts");
    expect(source).not.toMatch(/from "\.\/testdb\.mts"/);
  });

  it("Docker の識別のモジュール（lib/testing/testDbDocker.ts）と scripts/testdb.mts は、読み込んだだけでは Docker のコマンドも main() も実行しない", async () => {
    const execFile = vi.fn();
    const spawnChild = vi.fn();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile, spawn: spawnChild, default: { execFile, spawn: spawnChild } }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      const shared = await import("./testDbDocker.ts");
      const script = await import("../../scripts/testdb.mts");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(typeof shared.readTestDbDockerIdentity).toBe("function");
      expect(script.readTestDbDockerIdentity).toBe(shared.readTestDbDockerIdentity);
      expect(execFile).not.toHaveBeenCalled();
      expect(spawnChild).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
    } finally {
      error.mockRestore();
      log.mockRestore();
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("共有モジュールは、トップレベルで Docker のコマンド・環境変数・ファイルを使わず、main() を持たない", () => {
    const source = codeOf("lib/testing/testDbDocker.ts");
    expect(source).not.toMatch(/\bfunction main\(/);
    expect(source).not.toContain("import.meta");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("process.argv");
    expect(source).not.toMatch(/^(?:await |run|execFile|readTestDbDockerIdentity|runTestDb)\S*\(/m);
    // Docker のコマンドは shell を使わない
    expect(source).not.toMatch(/shell:\s*true/);
    expect(source).not.toMatch(/\bexec\(|execSync|spawnSync/);
  });
});

describe("Step 3-12B-1：有効な許可での runner の安全性（モックで有効にした許可。偽の関数だけで、Docker・DB・Prisma CLI は使わない）", () => {
  /** モックで明示的に有効にした許可（fake() の既定）。スクリプトの値は Step 3-12B-4 から LIVE_DATABASE_DISABLED */
  const MOCK_GATE = { mode: "enabled" } as const;
  const PRE_CHECKS = [
    "read:.env.test",
    "read:.env",
    "exists:node_modules/prisma/build/index.js",
    "exists:prisma.config.ts",
    "exists:prisma/schema.prisma",
    "exists:prisma/migrations",
  ];

  it("スクリプトの許可は固定の無効値で、引数は process.argv をそのまま渡し、許可の判定に使わない。モックの既定は有効値", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    expectScriptGateFixedDisabled(source);
    expect(source).toMatch(/^ {2}argv: process\.argv\.slice\(2\),$/m);
    expect(source.match(/process\.argv/g)).toHaveLength(1);
    expect(source.match(/process\.env/g)).toHaveLength(1);
    // 許可の値に、条件式・関数呼び出し・変数を使わない
    const gateLine = source.split("\n").find((line) => line.includes("liveDatabase"));
    expect(gateLine).toBe("  liveDatabase: LIVE_DATABASE_DISABLED,");
    expect(fake().deps.liveDatabase).toEqual(MOCK_GATE);
  });

  it.each<[string, string[]]>([
    ["引数なし（予行）", []],
    ["--check", ["--check"]],
    ["--verify", ["--verify"]],
  ])("%s は、許可が有効でも Prisma CLI を起動せず、migration 用の Docker の読み取り・判定も使わない", async (_label, argv) => {
    const f = fake({ argv });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.deps.liveDatabase).toEqual(MOCK_GATE);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("spawn");
    expect(f.calls).not.toContain("docker");
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbMigrateErrorCode]>([
    ["Node の起動オプション", { execArgv: ["--import", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["NODE_OPTIONS", { parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    [".env.test がない", { files: { ".env.test": undefined } }, "TEST_ENV_MISSING"],
    ["開発用DBと同じ接続先", { files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } } }, "TARGET_REJECTED"],
    ["見本のパスワード（R14）", { files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x" } } }, "CREDENTIALS_REJECTED"],
    ["親の PG*", { parentEnv: { PATH: "/usr/bin", PGUSER: "postgres" } }, "UNSAFE_PARENT_ENV"],
    ["Prisma CLI がない", { missingPaths: ["node_modules/prisma/build/index.js"] }, "REQUIRED_FILE_MISSING"],
  ])("--apply と有効な許可でも、事前の検証（%s）は省略せず、Docker・DB・Prisma CLI に触れる前に止まる", async (_label, overrides, code) => {
    const f = fake({ argv: ["--apply"], ...overrides });
    await expectStopped(f, code);
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbMigrateErrorCode, string[]]>([
    ["D1 の取得の失敗", { dockers: [Object.assign(new Error("x"), { code: "DOCKER_IDENTITY_MISMATCH" })] }, "DOCKER_IDENTITY_FAILED", ["docker"]],
    ["F1 の本人確認の失敗", { states: [new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", "x")] }, "STATE_CHECK_FAILED", ["docker", "classify"]],
    ["F1 のポートが 5432 でない", { servers: [{ ...SERVER, serverPort: 5434 }] }, "SERVER_IDENTITY_MISMATCH", ["docker", "classify"]],
    ["F1 の起動時刻が D1 の範囲外", { servers: [{ ...SERVER, postmasterStartTime: "2026-11-06T23:30:00.000000Z" }] }, "SERVER_IDENTITY_MISMATCH", ["docker", "classify"]],
    ["状態 B", { states: [STATE_B] }, "DATABASE_STATE_INCONSISTENT", ["docker", "classify"]],
    ["権限の不足", { privileges: { publicCreate: false } }, "MIGRATION_PRIVILEGES_INSUFFICIENT", ["docker", "classify"]],
    ["D2 の不一致", { dockers: [DOCKER, { ...DOCKER, restartCount: 1 }] }, "DOCKER_IDENTITY_MISMATCH", ["docker", "classify", "docker"]],
    ["D2 の取得の失敗", { dockers: [DOCKER, Object.assign(new Error("x"), { code: "DOCKER_COMMAND_FAILED" })] }, "DOCKER_IDENTITY_FAILED", ["docker", "classify", "docker"]],
  ])("--apply と有効な許可：%s は、Prisma CLI を起動する前に止まる（順序 D1 → F1 → D2 を守る）", async (_label, overrides, code, order) => {
    const f = fake({ argv: ["--apply"], ...overrides });
    const error = await expectError(f, code);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.calls.slice(0, PRE_CHECKS.length)).toEqual(PRE_CHECKS);
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(order);
    expect(error.message).not.toContain("migration may have been applied");
  });

  it("--apply と有効な許可：成功は D1 → F1 → D2 → Prisma CLI → F2 → D3 の順で、Prisma CLI は固定の migrate deploy を1回だけ", async () => {
    const f = fake({ argv: ["--apply"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual([...PRE_CHECKS, "docker", "classify", "docker", "spawn", "classify", "docker"]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][1]).toEqual(EXPECTED_ARGS);
    expect(f.spawn.mock.calls[0][2].shell).toBe(false);
  });

  it("--apply と有効な許可：Prisma CLI の失敗は、F2・D3 を実施せず、DB の状態は未確認として報告する", async () => {
    const f = fake({ argv: ["--apply"] });
    f.spawn.mockImplementationOnce(async () => {
      f.calls.push("spawn");
      return 2;
    });
    const error = await expectError(f, "MIGRATION_FAILED");
    expect(error.message).toContain("exited with code 2");
    expect(error.message).toContain("The post-migration checks (F2, D3) were not run and the database state is unverified.");
    expect(error.message).toContain("check the database state with npm run testdb:verify");
    expect(f.calls.slice(PRE_CHECKS.length)).toEqual(["docker", "classify", "docker", "spawn"]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("予行の表示は予行のもので、確認モードの文言（not run in check mode）を含まない", async () => {
    const f = fake({ argv: [] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    const output = f.logs.join("\n");
    expect(output).toContain("dry run (--apply was not given)");
    expect(output).toContain("and again after it (not run in this dry run; they run only with --apply)");
    expect(output).not.toContain("check mode");
    expect(output).toContain("live database access (migration gate): enabled");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("確認モードの表示は確認モードのもので、予行の文言を含まない", async () => {
    const f = fake({ argv: ["--check"] });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    const output = f.logs.join("\n");
    expect(output).toContain("check mode");
    expect(output).toContain("and again after it (not run in check mode)");
    expect(output).not.toContain("dry run");
    expect(output).toContain("live database access (migration gate): enabled");
  });
});

describe("Step 3-12B-4：固定ゲートの無効化（スクリプトと同じ LIVE_DATABASE_DISABLED。偽の関数だけで、Docker・DB・Prisma CLI は使わない）", () => {
  const PRE_CHECKS = [
    "read:.env.test",
    "read:.env",
    "exists:node_modules/prisma/build/index.js",
    "exists:prisma.config.ts",
    "exists:prisma/schema.prisma",
    "exists:prisma/migrations",
  ];

  it("スクリプトの許可の行は、固定の LIVE_DATABASE_DISABLED（import から来る凍結された無効値）だけ", () => {
    const source = codeOf("scripts/testdb-migrate.mts");
    expectScriptGateFixedDisabled(source);
    expect(source).toMatch(/import \{[^}]*\bLIVE_DATABASE_DISABLED\b[^}]*\} from "\.\.\/lib\/testing\/testDbMigrate\.ts";/);
    expect(LIVE_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(LIVE_DATABASE_DISABLED)).toBe(true);
  });

  it("--apply でも、事前の検証の後、Docker・DB・Prisma CLI に触れる前に TESTDB_MIGRATION_LIVE_DISABLED で止まる", async () => {
    const f = fake({ argv: ["--apply"], liveDisabled: true });
    const error = await expectStopped(f, "TESTDB_MIGRATION_LIVE_DISABLED");
    expect(error.message).toContain("refusing to connect to the test database, read Docker or start the Prisma CLI");
    expect(f.calls).toEqual(PRE_CHECKS);
  });

  it("--apply と無効な許可でも、事前の検証の失敗は先に報告する（検証は省略しない）", async () => {
    await expectStopped(fake({ argv: ["--apply"], liveDisabled: true, parentEnv: { PATH: "/usr/bin", PGHOST: "db.example.com" } }), "UNSAFE_PARENT_ENV");
    await expectStopped(fake({ argv: ["--apply"], liveDisabled: true, missingPaths: ["prisma/migrations"] }), "REQUIRED_FILE_MISSING");
  });

  it.each<[string, string[], string]>([
    ["引数なし（予行）", [], "dry run (--apply was not given)"],
    ["--check", ["--check"], "check mode"],
  ])("%s は、無効な許可で 0 で終わり、Prisma CLI・Docker・判定を使わず、ゲートが無効であることを表示する", async (_label, argv, heading) => {
    const f = fake({ argv, liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual(PRE_CHECKS);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
    const output = f.logs.join("\n");
    expect(output).toContain(heading);
    expect(output).toContain("live database access (migration gate): disabled in this build (--apply stops with TESTDB_MIGRATION_LIVE_DISABLED before reading Docker or connecting)");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("予行の表示は、無効な許可でも予行の文言で、確認モードの文言を含まない", async () => {
    const f = fake({ argv: [], liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    const output = f.logs.join("\n");
    expect(output).toContain("and again after it (not run in this dry run; they run only with --apply)");
    expect(output).not.toContain("check mode");
  });

  it("--verify は、migration 用の許可が無効でも読み取り専用の判定を1回だけ行い、Prisma CLI・Docker を使わない", async () => {
    const f = fake({ argv: ["--verify"], liveDisabled: true });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.readDockerIdentity).not.toHaveBeenCalled();
    expect(f.classify).not.toHaveBeenCalled();
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
