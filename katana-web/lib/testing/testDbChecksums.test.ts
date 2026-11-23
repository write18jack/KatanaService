import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { IntegrationDatabaseCheckError, type IntegrationDbClient, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import {
  compareMigrationChecksums,
  inspectMigrationChecksums,
  type LocalMigrationChecksum,
  MIGRATION_CHECKSUM_SQL,
  type MigrationChecksumComparison,
  MigrationChecksumError,
  readLocalMigrationChecksums,
} from "./migrationChecksum";
import { SCHEMA_DIFF_DISABLED } from "./schemaDiff";
import {
  CHECKSUM_DATABASE_DISABLED,
  EXPECTED_MIGRATION_COUNT,
  parseTestDbChecksumsArgs,
  runTestDbChecksums,
  type TestDbChecksumsDeps,
  TestDbChecksumsError,
  type TestDbChecksumsErrorCode,
} from "./testDbChecksums";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { type InspectDatabase, LIVE_DATABASE_DISABLED, type ReadDockerIdentity } from "./testDbMigrate";
import { SERVER_IDENTITY_SQL, type TestDatabasePrivileges, type TestDatabaseState } from "./testDbState";

// DB にも Docker にも接続せず、Prisma CLI も起動しない。Docker・DB の判定・checksum の照合は、すべて偽の関数で置き換える
// （リポジトリの prisma/migrations は読むだけ）
const ROOT = "/fake/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "checksums-dummy-pass";
const ADMIN_PASSWORD = "checksums-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"];
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };

/** リポジトリの8件の migration の名前と checksum（ファイルを読むだけ） */
const LOCAL: LocalMigrationChecksum[] = readLocalMigrationChecksums(path.join(REPO_ROOT, "prisma", "migrations"));
const NAMES = LOCAL.map((m) => m.name);
const goodRows = () => LOCAL.map((m) => ({ name: m.name, checksum: m.checksum, finished: true, rolledBack: false }));
const MATCH: MigrationChecksumComparison = compareMigrationChecksums(goodRows(), LOCAL);

const STATE_C: TestDatabaseState = { state: "C", tables: ["Shop"], migrations: [...NAMES], schemaDiff: "not-verified" };
const STATE_A: TestDatabaseState = { state: "A" };
const STATE_B: TestDatabaseState = { state: "B", reasons: ["migration history does not match"] };
const PRIVILEGES: TestDatabasePrivileges = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
const DOCKER: TestDbDockerIdentity = {
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  startedAt: "2026-11-06T22:46:49.619782389Z",
  restartCount: 0,
  networkId: "c".repeat(64),
  networkIp: "172.18.0.2",
  volumes: ["katana-web_postgres_data"],
  developmentVolume: ["katana-web_postgres_data"],
  portPublishers: ["katana-test-db"],
};
const SERVER: TestDatabaseServerIdentity = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-06T22:46:51.123456Z" };

type Fake = {
  deps: TestDbChecksumsDeps;
  docker: Mock<ReadDockerIdentity>;
  inspectDb: Mock<InspectDatabase>;
  checksums: Mock<TestDbChecksumsDeps["inspectChecksums"]>;
  local: Mock<TestDbChecksumsDeps["readLocalChecksums"]>;
  logs: string[];
  calls: string[];
};

function fake(
  o: {
    argv?: string[];
    enabled?: boolean;
    files?: Record<string, Record<string, string> | undefined>;
    parentEnv?: Record<string, string | undefined>;
    execArgv?: string[];
    missingPaths?: string[];
    local?: LocalMigrationChecksum[] | Error;
    states?: (TestDatabaseState | Error)[];
    servers?: TestDatabaseServerIdentity[];
    dockers?: (TestDbDockerIdentity | Error)[];
    checksum?: MigrationChecksumComparison | Error;
    inspectChecksums?: TestDbChecksumsDeps["inspectChecksums"];
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const files: Record<string, Record<string, string> | undefined> = { ".env.test": GOOD_TEST_ENV, ".env": { DATABASE_URL: DEV_URL }, ...o.files };
  const states = [...(o.states ?? [STATE_C, STATE_C])];
  const servers = [...(o.servers ?? [SERVER])];
  const dockers = [...(o.dockers ?? [DOCKER])];
  const local = vi.fn(() => {
    calls.push("local");
    if (o.local instanceof Error) throw o.local;
    return o.local ?? LOCAL;
  });
  const docker = vi.fn<ReadDockerIdentity>(async () => {
    calls.push("docker");
    const next = dockers.length > 1 ? dockers.shift() : dockers[0];
    if (next instanceof Error) throw next;
    return next as TestDbDockerIdentity;
  });
  const inspectDb = vi.fn<InspectDatabase>(async () => {
    calls.push("inspect");
    const next = states.shift();
    if (next === undefined) throw new Error("unexpected inspect call");
    if (next instanceof Error) throw next;
    return { state: next, privileges: PRIVILEGES, server: servers.length > 1 ? (servers.shift() as TestDatabaseServerIdentity) : servers[0] };
  });
  const checksums = vi.fn<TestDbChecksumsDeps["inspectChecksums"]>(async (input) => {
    calls.push("checksums");
    if (o.inspectChecksums) return o.inspectChecksums(input);
    const r = o.checksum ?? MATCH;
    if (r instanceof Error) throw r;
    return r;
  });
  const deps: TestDbChecksumsDeps = {
    root: ROOT,
    argv: o.argv ?? ["--verify"],
    execArgv: o.execArgv ?? [],
    parentEnv: o.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile: (p) => {
      const name = path.relative(ROOT, p);
      calls.push(`read:${name}`);
      return files[name];
    },
    pathExists: (p) => !(o.missingPaths ?? []).includes(path.relative(ROOT, p)),
    readLocalChecksums: local,
    checksumDatabase: o.enabled === false ? CHECKSUM_DATABASE_DISABLED : { mode: "enabled-read-only" },
    readDockerIdentity: docker,
    inspectDatabase: inspectDb,
    inspectChecksums: checksums,
    log: (t) => logs.push(t),
  };
  return { deps, docker, inspectDb, checksums, local, logs, calls };
}

function expectNoSecrets(f: Fake, error?: unknown) {
  for (const s of SECRETS) {
    if (error !== undefined) expect((error as Error).message).not.toContain(s);
    for (const line of f.logs) expect(line).not.toContain(s);
  }
  for (const m of LOCAL) {
    if (error !== undefined) expect((error as Error).message).not.toContain(m.checksum);
    for (const line of f.logs) expect(line).not.toContain(m.checksum);
  }
}

async function expectError(f: Fake, code: TestDbChecksumsErrorCode): Promise<Error> {
  const caught = await runTestDbChecksums(f.deps).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(TestDbChecksumsError);
  expect((caught as TestDbChecksumsError).code).toBe(code);
  expectNoSecrets(f, caught);
  return caught as Error;
}

/** Docker・DB・checksum の照合のどれにも触れずに止まる */
async function expectStopsBeforeLive(f: Fake, code: TestDbChecksumsErrorCode) {
  await expectError(f, code);
  expect(f.docker).not.toHaveBeenCalled();
  expect(f.inspectDb).not.toHaveBeenCalled();
  expect(f.checksums).not.toHaveBeenCalled();
}

const PRE = ["read:.env.test", "read:.env", "local"];

describe("引数", () => {
  it("引数なしは予行、--verify は照合。それ以外（--apply・併用・未知）は拒否する", () => {
    expect(parseTestDbChecksumsArgs([])).toBe("dry-run");
    expect(parseTestDbChecksumsArgs(["--verify"])).toBe("verify");
    for (const argv of [["--apply"], ["--verify", "--apply"], ["--verify", "--verify"], ["--check"], ["verify"], ["--verify=1"], ["--force"]]) {
      expect(() => parseTestDbChecksumsArgs(argv)).toThrow(/ARGUMENTS_INVALID/);
    }
  });

  it("不正な引数は、ファイル・Docker・DB に触れる前に止まる", async () => {
    const f = fake({ argv: ["--apply"] });
    await expectStopsBeforeLive(f, "ARGUMENTS_INVALID");
    expect(f.calls).toEqual([]);
  });
});

describe("予行（引数なし）", () => {
  it("事前の検証とローカルの checksum の計算だけで、Docker・DB に触れない（ゲートが有効でも）", async () => {
    const f = fake({ argv: [] });
    await expect(runTestDbChecksums(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual(PRE);
    expect(f.docker).not.toHaveBeenCalled();
    expect(f.inspectDb).not.toHaveBeenCalled();
    expect(f.checksums).not.toHaveBeenCalled();
    const text = f.logs.join("\n");
    expect(text).toContain(`local migrations: ${EXPECTED_MIGRATION_COUNT}`);
    for (const name of NAMES) expect(text).toContain(name);
    expectNoSecrets(f);
  });

  it("ゲートが無効なら、そのことを表示する", async () => {
    const f = fake({ argv: [], enabled: false });
    await expect(runTestDbChecksums(f.deps)).resolves.toBe(0);
    expect(f.logs.join("\n")).toContain("disabled in this build");
    expect(f.docker).not.toHaveBeenCalled();
  });
});

describe("接続先の拒否（Docker・DB に触れない）", () => {
  it("開発用DBと同じ接続先・テストDB以外の接続先・クエリ付きのURL", async () => {
    await expectStopsBeforeLive(fake({ files: { ".env": { DATABASE_URL: TEST_URL } } }), "TARGET_REJECTED");
    for (const url of [DEV_URL, `${TEST_URL}?sslmode=disable`, `postgresql://katana_test_user:${PASSWORD}@db.example.com:5434/katana_test`]) {
      await expectStopsBeforeLive(fake({ files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: url } } }), "TARGET_REJECTED");
    }
  });

  it(".env.test がない・パスワードが不正", async () => {
    await expectStopsBeforeLive(fake({ files: { ".env.test": undefined } }), "TEST_ENV_MISSING");
    await expectStopsBeforeLive(fake({ files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x" } } }), "CREDENTIALS_REJECTED");
  });

  it("親の PG*・DOTENV_*・NODE_OPTIONS・Node の起動オプション", async () => {
    await expectStopsBeforeLive(fake({ parentEnv: { PGHOST: "elsewhere" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { DOTENV_CONFIG_PATH: ".env" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { NODE_OPTIONS: "--require x" } }), "NODE_OPTIONS_PRESENT");
    await expectStopsBeforeLive(fake({ execArgv: ["--import", "x"] }), "NODE_EXEC_ARGV_PRESENT");
  });

  it("必要なファイルがない・ローカルの migration が読めない・件数が8件でない", async () => {
    await expectStopsBeforeLive(fake({ missingPaths: ["prisma/migrations"] }), "REQUIRED_FILE_MISSING");
    await expectStopsBeforeLive(fake({ local: Object.assign(new Error(TEST_URL), { code: "UNEXPECTED_ENTRY" }) }), "LOCAL_MIGRATIONS_INVALID");
    await expectStopsBeforeLive(fake({ local: LOCAL.slice(0, 7) }), "MIGRATION_COUNT_MISMATCH");
    expect(EXPECTED_MIGRATION_COUNT).toBe(8);
    expect(LOCAL).toHaveLength(EXPECTED_MIGRATION_COUNT);
  });
});

describe("ゲート", () => {
  it("--verify でも、固定のゲートが無効なら、事前の検証の後で Docker・DB に触れずに止まる", async () => {
    const f = fake({ enabled: false });
    await expectStopsBeforeLive(f, "CHECKSUM_LIVE_DISABLED");
    expect(f.calls).toEqual(PRE);
  });

  it("ゲートは migration 用・schemaDiff 用とは別の凍結された値", () => {
    expect(CHECKSUM_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(CHECKSUM_DATABASE_DISABLED)).toBe(true);
    expect(CHECKSUM_DATABASE_DISABLED).not.toBe(LIVE_DATABASE_DISABLED);
    expect(CHECKSUM_DATABASE_DISABLED).not.toBe(SCHEMA_DIFF_DISABLED);
    expect(LIVE_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(SCHEMA_DIFF_DISABLED).toEqual({ mode: "disabled" });
  });
});

describe("--verify の手順（モックで有効にしたゲート）", () => {
  it("正常系：事前検証 → D1 → F1 → D2 → checksum → F2 → D3 の順で、すべて一致したら0", async () => {
    const f = fake();
    await expect(runTestDbChecksums(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual([...PRE, "docker", "inspect", "docker", "checksums", "inspect", "docker"]);
    // D1・F1 の識別情報を、checksum の接続に渡す（同じ接続の中で、履歴を読む前に照合する）
    expect(f.checksums).toHaveBeenCalledWith({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, expectedServer: { docker: DOCKER, server: SERVER } });
    expect(f.logs.join("\n")).toContain(`all ${EXPECTED_MIGRATION_COUNT} migration checksums match exactly`);
    expectNoSecrets(f);
  });

  it("Docker の識別の失敗（D1）・不一致（D2）では checksum を照合しない", async () => {
    const d1 = fake({ dockers: [Object.assign(new Error(TEST_URL), { code: "CONTEXT_MISMATCH" })] });
    expect((await expectError(d1, "DOCKER_IDENTITY_FAILED")).message).toContain("CONTEXT_MISMATCH");
    expect(d1.inspectDb).not.toHaveBeenCalled();
    const d2 = fake({ dockers: [DOCKER, { ...DOCKER, containerId: "d".repeat(64) }] });
    await expectError(d2, "DOCKER_IDENTITY_MISMATCH");
    expect(d2.checksums).not.toHaveBeenCalled();
  });

  it("PostgreSQL と Docker の識別情報が合わない（ポート・起動時刻）なら、checksum を照合しない", async () => {
    for (const server of [{ ...SERVER, serverPort: 5433 }, { ...SERVER, postmasterStartTime: "2026-11-07T22:46:51.000000Z" }]) {
      const f = fake({ servers: [server] });
      await expectError(f, "SERVER_IDENTITY_MISMATCH");
      expect(f.checksums).not.toHaveBeenCalled();
    }
  });

  it("DB の本人確認の失敗（F1）では、コードだけを表示して checksum を照合しない", async () => {
    for (const code of ["CURRENT_USER_MISMATCH", "MARKER_MISMATCH", "NOT_READ_ONLY", "SEARCH_PATH_NOT_PINNED", "CONNECT_FAILED"] as const) {
      const f = fake({ states: [new IntegrationDatabaseCheckError(code, `bad ${TEST_URL}`)] });
      expect((await expectError(f, "STATE_CHECK_FAILED")).message).toContain(code);
      expect(f.checksums).not.toHaveBeenCalled();
    }
  });

  it("状態 A・B は拒否し、checksum を照合しない", async () => {
    for (const state of [STATE_A, STATE_B]) {
      const f = fake({ states: [state] });
      await expectError(f, "DATABASE_STATE_NOT_C");
      expect(f.checksums).not.toHaveBeenCalled();
    }
  });

  it("migration の履歴の不足（状態 C でも、適用済みの一覧がローカルの8件と一致しない）は拒否する", async () => {
    for (const migrations of [NAMES.slice(0, 7), [...NAMES.slice(0, 7), "20990101000000_other"]]) {
      const f = fake({ states: [{ ...STATE_C, migrations }] });
      await expectError(f, "MIGRATION_LIST_MISMATCH");
      expect(f.checksums).not.toHaveBeenCalled();
    }
  });

  it("checksum の不一致（値の違い・不足・未完了）は失敗。名前だけを表示し、checksum の値は表示しない", async () => {
    const tampered = goodRows().map((row, i) => (i === 2 ? { ...row, checksum: "0".repeat(64) } : row));
    const e1 = await expectError(fake({ checksum: compareMigrationChecksums(tampered, LOCAL) }), "CHECKSUM_MISMATCH");
    expect(e1.message).toContain(`checksum mismatch: ${NAMES[2]}`);
    expect(e1.message).not.toContain("0".repeat(64));
    await expectError(fake({ checksum: compareMigrationChecksums(goodRows().slice(1), LOCAL) }), "CHECKSUM_MISMATCH");
    await expectError(fake({ checksum: compareMigrationChecksums(goodRows().map((r) => ({ ...r, finished: false })), LOCAL) }), "CHECKSUM_MISMATCH");
  });

  it("checksum の SQL の失敗は失敗（コードだけ）。F2・D3 は行う", async () => {
    const f = fake({ checksum: new IntegrationDatabaseCheckError("QUERY_FAILED", `migration checksum listing failed (42P01) ${TEST_URL}`) });
    expect((await expectError(f, "CHECKSUM_CHECK_FAILED")).message).toContain("QUERY_FAILED");
    expect(f.calls.slice(-3)).toEqual(["checksums", "inspect", "docker"]);
  });

  it("checksum の接続の識別の不一致は、F2・D3 を行った上で失敗（項目名だけ。checksum の結果は使わない）", async () => {
    const f = fake({ checksum: new MigrationChecksumError("SERVER_IDENTITY_MISMATCH", "the checksum connection does not reach the verified server (serverPort differs from F1).") });
    const error = await expectError(f, "CHECKSUM_CONNECTION_IDENTITY_MISMATCH");
    expect(error.message).toContain("serverPort differs from F1");
    expect(error.message).toContain("The migration history was not read.");
    expect(f.calls.slice(-3)).toEqual(["checksums", "inspect", "docker"]);
  });

  it("12. checksum の接続の識別の不一致より、F2・D3 の異常を先に報告する（事後の検証は省略しない）", async () => {
    const mismatch = new MigrationChecksumError("SERVER_IDENTITY_MISMATCH", "x");
    await expectError(fake({ checksum: mismatch, dockers: [DOCKER, DOCKER, { ...DOCKER, restartCount: 1 }] }), "POST_IDENTITY_MISMATCH");
    await expectError(fake({ checksum: mismatch, states: [STATE_C, STATE_B] }), "POST_STATE_MISMATCH");
  });

  it("F2・D3 の失敗・不一致・状態の変化は、checksum が一致していても成功と扱わない", async () => {
    await expectError(fake({ states: [STATE_C, new IntegrationDatabaseCheckError("CONNECT_FAILED", "x")] }), "POST_CHECK_FAILED");
    await expectError(fake({ servers: [SERVER, { ...SERVER, serverAddress: "172.18.0.9" }] }), "POST_IDENTITY_MISMATCH");
    await expectError(fake({ dockers: [DOCKER, DOCKER, { ...DOCKER, restartCount: 1 }] }), "POST_IDENTITY_MISMATCH");
    await expectError(fake({ dockers: [DOCKER, DOCKER, new Error("docker gone")] }), "DOCKER_IDENTITY_FAILED");
    await expectError(fake({ states: [STATE_C, STATE_B] }), "POST_STATE_MISMATCH");
  });
});

describe("本物の inspectMigrationChecksums と偽のDBクライアント（実DBには接続しない）", () => {
  /** 読み取り専用のトランザクションの SQL だけに応答する偽のクライアント */
  function fakeDb(o: { rows?: Record<string, unknown>[]; failOn?: string; readOnly?: string; server?: Record<string, unknown> } = {}) {
    const queries: string[] = [];
    const end = vi.fn(async () => undefined);
    const client: IntegrationDbClient = {
      query: async (sql) => {
        queries.push(sql);
        if (o.failOn && sql.includes(o.failOn)) throw Object.assign(new Error(`boom ${TEST_URL}`), { code: "42P01" });
        if (sql === "BEGIN READ ONLY" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("set_config")) return { rows: [{ searchPath: "pg_catalog" }] };
        if (sql.includes("transaction_read_only")) return { rows: [{ transaction_read_only: o.readOnly ?? "on" }] };
        if (sql.includes("current_database()")) {
          return { rows: [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 }] };
        }
        if (sql === SERVER_IDENTITY_SQL) return { rows: [o.server ?? { ...SERVER }] };
        if (sql === MIGRATION_CHECKSUM_SQL) return { rows: o.rows ?? goodRows() };
        throw new Error(`unexpected SQL in test: ${sql}`);
      },
      end,
    };
    return { queries, end, connect: vi.fn(async () => client) };
  }
  const real = (db: ReturnType<typeof fakeDb>): TestDbChecksumsDeps["inspectChecksums"] => (input) =>
    inspectMigrationChecksums({ ...input, migrationsDir: path.join(REPO_ROOT, "prisma", "migrations"), connect: db.connect });

  it("一致：BEGIN READ ONLY・search_path の固定・transaction_read_only=on・本人確認・サーバーの識別・SELECT・ROLLBACK・接続の解放", async () => {
    const db = fakeDb();
    await expect(runTestDbChecksums(fake({ inspectChecksums: real(db) }).deps)).resolves.toBe(0);
    expect(db.connect).toHaveBeenCalledWith(TEST_URL);
    expect(db.queries[0]).toBe("BEGIN READ ONLY");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.queries.some((q) => q.includes("set_config('search_path', 'pg_catalog', true)"))).toBe(true);
    expect(db.queries).toContain("SHOW transaction_read_only");
    expect(db.queries.indexOf(SERVER_IDENTITY_SQL)).toBeGreaterThan(0);
    expect(db.queries.indexOf(SERVER_IDENTITY_SQL)).toBeLessThan(db.queries.indexOf(MIGRATION_CHECKSUM_SQL));
    for (const q of db.queries.slice(1, -1)) expect(q.trimStart()).toMatch(/^(SELECT|SHOW) /);
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("checksum の接続で読んだサーバー（IP・ポート・起動時刻）が D1・F1 と違えば、履歴を読まずに失敗する（ROLLBACK・接続の解放。F2・D3 は行う）", async () => {
    for (const server of [
      { ...SERVER, serverAddress: "172.18.0.9" },
      { ...SERVER, serverPort: 5433 },
      { ...SERVER, postmasterStartTime: "2026-11-06T22:46:52.000000Z" },
      { ...SERVER, postmasterStartTime: "2026-11-07T22:46:51.000000Z" },
    ]) {
      const db = fakeDb({ server });
      const f = fake({ inspectChecksums: real(db) });
      const error = await expectError(f, "CHECKSUM_CONNECTION_IDENTITY_MISMATCH");
      // 項目名だけを表示し、値（IP・ポート・時刻）は表示しない
      for (const value of ["172.18.0.9", "5433", "2026-11-06T22:46:52", "2026-11-07"]) expect(error.message).not.toContain(value);
      expect(db.queries).not.toContain(MIGRATION_CHECKSUM_SQL);
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
      expect(f.calls.slice(-3)).toEqual(["checksums", "inspect", "docker"]);
    }
  });

  it("checksum の接続で、サーバーの識別情報が読めない（NULL）なら、履歴を読まずに失敗する", async () => {
    const db = fakeDb({ server: { ...SERVER, serverAddress: null } });
    expect((await expectError(fake({ inspectChecksums: real(db) }), "CHECKSUM_CHECK_FAILED")).message).toContain("SERVER_IDENTITY_UNAVAILABLE");
    expect(db.queries).not.toContain(MIGRATION_CHECKSUM_SQL);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
  });

  it("transaction_read_only が on でなければ、履歴を読まずに失敗する", async () => {
    const db = fakeDb({ readOnly: "off" });
    const f = fake({ inspectChecksums: real(db) });
    expect((await expectError(f, "CHECKSUM_CHECK_FAILED")).message).toContain("NOT_READ_ONLY");
    expect(db.queries).not.toContain(MIGRATION_CHECKSUM_SQL);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("SQL の失敗：ROLLBACK と接続の解放を行い、ドライバのメッセージを表示しない", async () => {
    const db = fakeDb({ failOn: "_prisma_migrations" });
    const f = fake({ inspectChecksums: real(db) });
    expect((await expectError(f, "CHECKSUM_CHECK_FAILED")).message).toContain("QUERY_FAILED");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
  });
});

describe("静的な確認（ソース）", () => {
  const code = (file: string) =>
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "");

  it("スクリプトのゲートは固定の CHECKSUM_DATABASE_DISABLED で、引数・環境変数から決めない", () => {
    const source = code("scripts/testdb-checksums.mts");
    const gateLines = source.split("\n").filter((line) => line.includes("checksumDatabase"));
    expect(gateLines).toEqual(["  checksumDatabase: CHECKSUM_DATABASE_DISABLED,"]);
    expect(source.match(/process\.argv/g)).toHaveLength(1);
    expect(source).toMatch(/^ {2}argv: process\.argv\.slice\(2\),$/m);
    expect(source.match(/process\.env/g)).toHaveLength(1);
    expect(source).toMatch(/^ {2}parentEnv: process\.env,$/m);
  });

  it("checksum の経路は migration を適用できない（Prisma CLI・子プロセス・migration 用と schemaDiff 用のゲートを参照しない）", () => {
    for (const file of ["scripts/testdb-checksums.mts", "lib/testing/testDbChecksums.ts"]) {
      const source = code(file);
      for (const forbidden of [
        "child_process",
        "spawn",
        "execFile",
        "LIVE_DATABASE_DISABLED",
        "liveDatabase",
        "runTestDbMigrate",
        "PRISMA_CLI_ENTRY",
        "PRISMA_MIGRATE_COMMAND",
        "migrate deploy",
        "schemaDiff",
        "SCHEMA_DIFF",
        "@prisma/client",
        "@/lib/prisma",
        "prisma/build",
        '"pg"',
        "writeFile",
        "--apply",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    // 本体は DB ドライバ・Docker のコマンドを直接読み込まない（スクリプトから注入する）
    const lib = code("lib/testing/testDbChecksums.ts");
    for (const forbidden of ["testDbConnection", "testDbDocker", "runDockerCommand"]) expect(lib).not.toContain(forbidden);
  });

  it("npm の testdb:checksums は、引数なし（予行）でスクリプトを実行する。--verify 付きの npm スクリプトはない", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:checksums"]).toBe("node scripts/testdb-checksums.mts");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("testdb-checksums.mts"))).toEqual(["node scripts/testdb-checksums.mts"]);
  });

  it("既存の migration 用の固定ゲートは、Step 4-8B の一時的な有効化（固定のリテラル）のほかは変えていない", () => {
    expect(code("scripts/testdb-migrate.mts")).toMatch(/^ {2}liveDatabase: \{ mode: "enabled" \},$/m); // Step 4-8B：テストDB の復旧のために一時的に有効（固定のリテラル。migrate --apply の1回の後、LIVE_DATABASE_DISABLED に戻す）
  });
});
