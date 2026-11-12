import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { SCHEMA_DIFF_DISABLED } from "./schemaDiff";
import {
  CATALOG_FINGERPRINT_SECTIONS,
  type CatalogAuditExpectation,
  type CatalogDefinitionAuditResult,
  type CatalogFingerprint,
  loadCatalogAuditExpectation,
  type ReadOnlyRoleSnapshot,
} from "./testDbCatalogAudit";
import { CATALOG_AUDIT_DATABASE_DISABLED } from "./testDbCatalogRunner";
import { CHECKSUM_DATABASE_DISABLED, EXPECTED_MIGRATION_COUNT } from "./testDbChecksums";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { type InspectDatabase, LIVE_DATABASE_DISABLED, type ReadDockerIdentity } from "./testDbMigrate";
import {
  EXEC_ENV,
  EXPECTED_PRE_CHANGE_SCHEMAS,
  EXPECTED_PRE_CHANGE_SYSTEM_DATABASES,
  EXPECTED_PRE_CHANGE_TEST_DATABASE,
  EXPECTED_ROLE_CONFIG_MD5,
  expectedReadOnlyRoleTables,
  READ_ONLY_ROLE_SQL_FILES,
  type PreChangeAclObservation,
  type ReadOnlyRoleObservation,
  type ReadOnlyRoleOperation,
  RO_ROLE_CREATE_DISABLED,
  RO_ROLE_GRANT_SYNC_DISABLED,
  sha256Hex,
} from "./testDbReadOnlyRole";
import {
  EXPECTED_RO_ROLE_MIGRATION_COUNT,
  parseTestDbReadOnlyRoleArgs,
  type ReadOnlyRoleExecResult,
  runTestDbReadOnlyRole,
  type TestDbReadOnlyRoleDeps,
  TestDbReadOnlyRoleError,
  type TestDbReadOnlyRoleErrorCode,
} from "./testDbReadOnlyRoleRunner";
import type { TestDatabasePrivileges, TestDatabaseState } from "./testDbState";

// Docker にも DB にも接続せず、docker exec も起動しない。Docker・DB・カタログ・読み取り専用ロールの検査・exec は、すべて偽の関数で置き換える。
// SQL ファイルと期待値は、リポジトリのファイルを読むだけ
const ROOT = "/fake/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const code = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

const APP_PASSWORD = "ro-runner-app-dummy-password";
const ADMIN_PASSWORD = "ro-runner-admin-dummy-password";
const RO_PASSWORD = "ro_runner_dummy_password_0123456789abcd";
const APP_URL = `postgresql://katana_test_user:${APP_PASSWORD}@127.0.0.1:5434/katana_test`;
const RO_URL = `postgresql://katana_test_ro:${RO_PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "ro-runner-dev-dummy";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const VERIFIER = `SCRAM-SHA-256$4096:${Buffer.alloc(16, 3).toString("base64")}$${Buffer.alloc(32, 4).toString("base64")}:${Buffer.alloc(32, 5).toString("base64")}`;
const SECRETS = [APP_PASSWORD, ADMIN_PASSWORD, RO_PASSWORD, APP_URL, RO_URL, DEV_PASSWORD, DEV_URL, VERIFIER, sha256Hex(VERIFIER), "postgresql://katana", "SCRAM-SHA-256$"];
const TEST_ENV = { DATABASE_URL: APP_URL, KATANA_TEST_DB_PASSWORD: APP_PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const RO_ENV = { KATANA_TEST_RO_DATABASE_URL: RO_URL, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD };

const EXPECTATION = loadCatalogAuditExpectation(REPO_ROOT);
const TABLES = expectedReadOnlyRoleTables(EXPECTATION);
const SQL = { create: code(READ_ONLY_ROLE_SQL_FILES.create), "grant-sync": code(READ_ONLY_ROLE_SQL_FILES["grant-sync"]) };

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
const PRIVILEGES: TestDatabasePrivileges = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
const STATE_C: TestDatabaseState = { state: "C", tables: [...EXPECTATION.inventory.tables], migrations: [...EXPECTATION.inventory.migrations], schemaDiff: "not-verified" };

// ---- fingerprint（runCatalogDefinitionAudit の結果）の偽物：18区分。値は ACL・ロール・設定だけを意味のある形にする ----
const row = (fields: Record<string, unknown>) => JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
const key = (...parts: string[]) => JSON.stringify(parts);
const TABLE_ACL = "{katana_test_user=arwdDxt/katana_test_user,katana_test_ro=r/katana_test_user}";
const DB_ACL = "{=c/katana_test_user,katana_test_user=CTc/katana_test_user}";

function fp(o: { granted?: readonly string[]; created?: boolean; largeObject?: boolean } = {}): CatalogFingerprint {
  const granted = new Set(o.granted ?? []);
  const sections: Record<string, (readonly [string, string])[]> = Object.fromEntries(Object.keys(CATALOG_FINGERPRINT_SECTIONS).map((s) => [s, []]));
  sections.database = [[key("katana_test"), row({ name: "katana_test", owner: "katana_test_user", acl: o.created ? DB_ACL : null, comment: "katana-test-db" })]];
  sections.relations = TABLES.map((name) => [key("public", name), row({ schema: "public", name, kind: "r", persistence: "p", rowSecurity: false, forceRowSecurity: false, owner: "katana_test_user", acl: granted.has(name) ? TABLE_ACL : null })] as const);
  sections.roles = [[key("katana_test_user"), row({ name: "katana_test_user", superuser: false, inherit: true, createRole: false, createDb: false, login: true, replication: false, bypassRls: false, connectionLimit: -1, config: null })]];
  if (o.created) {
    sections.roles.push([key("katana_test_ro"), row({ name: "katana_test_ro", superuser: false, inherit: false, createRole: false, createDb: false, login: true, replication: false, bypassRls: false, connectionLimit: -1, config: EXPECTED_ROLE_CONFIG_MD5 })]);
    sections.dbRoleSettings = [[key("all", "", "one", "katana_test_ro"), row({ databaseScope: "all", database: "", roleScope: "one", role: "katana_test_ro", configHash: EXPECTED_ROLE_CONFIG_MD5 })]];
  }
  if (o.largeObject) sections.largeObjects = [[key("katana_test_ro"), row({ owner: "katana_test_ro", count: 1 })]];
  for (const name of Object.keys(sections)) sections[name] = [...sections[name]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { meaning: "observed-catalog-definition", sha256: sha256Hex(JSON.stringify(sections)), sections };
}
const audit = (fingerprint: CatalogFingerprint): CatalogDefinitionAuditResult => ({ report: { verdict: "passed", findings: [] }, fingerprint });

// ---- 読み取り専用ロールの観測（runReadOnlyRoleCheck の結果）の偽物 ----
function observation(granted: readonly string[] = TABLES): ReadOnlyRoleObservation {
  const g = new Set(granted);
  const snapshot: ReadOnlyRoleSnapshot = {
    role: { currentUser: "katana_test_ro", sessionUser: "katana_test_ro", superuser: false, inherit: false, createRole: false, createDb: false, replication: false, bypassRls: false, defaultReadOnly: "on" },
    memberships: [],
    ownership: ["relation", "type", "schema", "routine", "database", "large object", "default privileges"].map((kind) => ({ kind, count: 0 })),
    database: { databaseCreate: false, databaseTemporary: false, schemaCreate: false, schemaUsage: true },
    tables: TABLES.map((table) => ({ table, select: g.has(table), insert: false, update: false, delete: false, truncate: false, references: false, trigger: false })),
    sequences: [],
    catalogColumns: TABLES.map((table) => ({ table, column: "id" })),
    visibleColumns: TABLES.filter((t) => g.has(t)).map((table) => ({ table, column: "id" })),
  };
  return {
    snapshot,
    dependencies: granted.map((objectName) => ({ database: "katana_test", catalog: "pg_class", subId: 0, type: "a", objectName })),
    databases: [
      { name: "katana_test", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "postgres", allowConnections: true, connect: false, temporary: false, create: false, explicitGrants: 0 },
      { name: "template0", allowConnections: false, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "template1", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
    ],
    tableAcl: TABLES.map((table) => ({ table, aclNull: !g.has(table) })),
  };
}

/** A0 の観測（期待値どおり）。操作ごとに katana_test の行だけが違う */
function aclObservation(operation: ReadOnlyRoleOperation): PreChangeAclObservation {
  return {
    databases: [...EXPECTED_PRE_CHANGE_SYSTEM_DATABASES, EXPECTED_PRE_CHANGE_TEST_DATABASE[operation]].map((d) => ({ ...d })),
    schemas: EXPECTED_PRE_CHANGE_SCHEMAS.map((n) => ({ ...n })),
  };
}

type ExecCall = { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; input: string; shell: boolean };

type Fake = {
  deps: TestDbReadOnlyRoleDeps;
  docker: Mock<ReadDockerIdentity>;
  inspectDb: Mock<InspectDatabase>;
  audit: Mock<TestDbReadOnlyRoleDeps["runAudit"]>;
  role: Mock<TestDbReadOnlyRoleDeps["checkReadOnlyRole"]>;
  acl: Mock<TestDbReadOnlyRoleDeps["checkPreChangeAcl"]>;
  exec: Mock<TestDbReadOnlyRoleDeps["exec"]>;
  execCalls: ExecCall[];
  logs: string[];
  calls: string[];
};

function fake(
  o: {
    argv?: string[];
    gates?: "disabled" | "create" | "grant-sync" | "both";
    testEnv?: Record<string, string | undefined> | null;
    roEnv?: Record<string, string | undefined> | null;
    parentEnv?: Record<string, string | undefined>;
    execArgv?: string[];
    readFile?: (p: string) => string;
    expectation?: () => CatalogAuditExpectation;
    fingerprints?: CatalogFingerprint[];
    observations?: ReadOnlyRoleObservation[];
    dockers?: TestDbDockerIdentity[];
    states?: TestDatabaseState[];
    execResult?: ReadOnlyRoleExecResult;
    /** A0 の観測（既定は、引数の操作の期待値どおり）。Error なら A0 の接続の失敗 */
    acl?: PreChangeAclObservation | Error;
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const execCalls: ExecCall[] = [];
  const gates = o.gates ?? "both";
  const n = { docker: 0, inspect: 0, audit: 0, role: 0 };
  const docker = vi.fn<ReadDockerIdentity>(async () => {
    n.docker += 1;
    calls.push(`D${n.docker}`);
    return { ...(o.dockers?.[n.docker - 1] ?? DOCKER) };
  });
  const inspectDb = vi.fn<InspectDatabase>(async () => {
    n.inspect += 1;
    calls.push(`F${n.inspect}`);
    return { state: o.states?.[n.inspect - 1] ?? STATE_C, privileges: PRIVILEGES, server: { ...SERVER } };
  });
  const auditFn = vi.fn<TestDbReadOnlyRoleDeps["runAudit"]>(async () => {
    n.audit += 1;
    calls.push(`FP${n.audit - 1}`);
    const list = o.fingerprints ?? [fp(), fp({ created: true, granted: TABLES })];
    return audit(list[Math.min(n.audit - 1, list.length - 1)]);
  });
  const role = vi.fn<TestDbReadOnlyRoleDeps["checkReadOnlyRole"]>(async () => {
    n.role += 1;
    calls.push(`R${n.role}`);
    const list = o.observations ?? [observation()];
    return list[Math.min(n.role - 1, list.length - 1)];
  });
  const acl = vi.fn<TestDbReadOnlyRoleDeps["checkPreChangeAcl"]>(async () => {
    calls.push("A0");
    if (o.acl instanceof Error) throw o.acl;
    return o.acl ?? aclObservation((o.argv ?? ["--create"])[0] === "--grant-sync" ? "grant-sync" : "create");
  });
  const exec = vi.fn<TestDbReadOnlyRoleDeps["exec"]>(async (command, args, options) => {
    calls.push("exec");
    execCalls.push({ command, args, env: options.env, input: options.input, shell: options.shell });
    return o.execResult ?? { kind: "exit", code: 0, signal: null, stdout: "", stderr: "" };
  });
  const deps: TestDbReadOnlyRoleDeps = {
    root: ROOT,
    argv: o.argv ?? ["--create", "--apply"],
    execArgv: o.execArgv ?? [],
    parentEnv: o.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/test" },
    readEnvFile: (file) => {
      if (file.endsWith(".env.test.readonly")) return o.roEnv === null ? undefined : (o.roEnv ?? RO_ENV);
      if (file.endsWith(".env.test")) return o.testEnv === null ? undefined : (o.testEnv ?? TEST_ENV);
      if (file.endsWith(".env")) return { DATABASE_URL: DEV_URL };
      return undefined;
    },
    pathExists: () => true,
    readFile: o.readFile ?? ((p) => (p.endsWith("01-create.sql") ? SQL.create : SQL["grant-sync"])),
    loadExpectation: o.expectation ?? (() => EXPECTATION),
    createGate: gates === "create" || gates === "both" ? { mode: "enabled-create" } : RO_ROLE_CREATE_DISABLED,
    grantSyncGate: gates === "grant-sync" || gates === "both" ? { mode: "enabled-grant-sync" } : RO_ROLE_GRANT_SYNC_DISABLED,
    readDockerIdentity: docker,
    inspectDatabase: inspectDb,
    runAudit: auditFn,
    checkReadOnlyRole: role,
    checkPreChangeAcl: acl,
    exec,
    createVerifier: () => VERIFIER,
    log: (text) => logs.push(text),
  };
  return { deps, docker, inspectDb, audit: auditFn, role, acl, exec, execCalls, logs, calls };
}

function noSecrets(f: Fake, error?: unknown) {
  for (const secret of SECRETS) {
    if (error) expect((error as Error).message).not.toContain(secret);
    for (const line of f.logs) expect(line).not.toContain(secret);
  }
}

async function expectError(f: Fake, expected: TestDbReadOnlyRoleErrorCode): Promise<TestDbReadOnlyRoleError> {
  try {
    await runTestDbReadOnlyRole(f.deps);
  } catch (error) {
    expect(error).toBeInstanceOf(TestDbReadOnlyRoleError);
    expect((error as TestDbReadOnlyRoleError).code).toBe(expected);
    noSecrets(f, error);
    return error as TestDbReadOnlyRoleError;
  }
  throw new Error(`expected ${expected}`);
}

const touchedNothing = (f: Fake) => {
  expect(f.docker).not.toHaveBeenCalled();
  expect(f.inspectDb).not.toHaveBeenCalled();
  expect(f.audit).not.toHaveBeenCalled();
  expect(f.role).not.toHaveBeenCalled();
  expect(f.acl).not.toHaveBeenCalled();
  expect(f.exec).not.toHaveBeenCalled();
};

describe("引数・予行・固定のゲート（Docker・DB に触れない）", () => {
  it("引数は固定の4通りだけ", () => {
    expect(parseTestDbReadOnlyRoleArgs(["--create"])).toEqual({ operation: "create", apply: false });
    expect(parseTestDbReadOnlyRoleArgs(["--grant-sync", "--apply"])).toEqual({ operation: "grant-sync", apply: true });
    for (const args of [[], ["--apply"], ["--apply", "--create"], ["--create", "--grant-sync"], ["--create", "--apply", "--force"], ["--verify"], ["--sql", "x"]]) {
      expect(() => parseTestDbReadOnlyRoleArgs(args)).toThrow(TestDbReadOnlyRoleError);
    }
  });

  it.each([["--create"], ["--grant-sync"]])("予行（%s）は、ゲートが有効でも Docker・DB・exec に触れない", async (arg) => {
    const f = fake({ argv: [arg] });
    expect(await runTestDbReadOnlyRole(f.deps)).toEqual({ mode: "dry-run", operation: arg.slice(2) });
    touchedNothing(f);
    expect(f.logs.join("\n")).toContain("<container id from D1>");
    noSecrets(f);
  });

  it("予行は、ゲートが無効であることと、--apply で止まるコードを表示する", async () => {
    const f = fake({ argv: ["--create"], gates: "disabled" });
    await runTestDbReadOnlyRole(f.deps);
    expect(f.logs.join("\n")).toContain("RO_ROLE_CREATE_DISABLED");
  });

  it("スクリプトの固定のゲート（無効）では、--create --apply も --grant-sync --apply も、Docker・DB・exec に触れずに止まる", async () => {
    const create = fake({ argv: ["--create", "--apply"], gates: "disabled" });
    await expectError(create, "RO_ROLE_CREATE_DISABLED");
    touchedNothing(create);
    const sync = fake({ argv: ["--grant-sync", "--apply"], gates: "disabled" });
    await expectError(sync, "RO_ROLE_GRANT_SYNC_DISABLED");
    touchedNothing(sync);
  });

  it("片方のゲートを有効にしても、もう片方の操作は止まる", async () => {
    const f1 = fake({ argv: ["--grant-sync", "--apply"], gates: "create" });
    await expectError(f1, "RO_ROLE_GRANT_SYNC_DISABLED");
    touchedNothing(f1);
    const f2 = fake({ argv: ["--create", "--apply"], gates: "grant-sync" });
    await expectError(f2, "RO_ROLE_CREATE_DISABLED");
    touchedNothing(f2);
  });

  it("環境変数でゲートを変えられない", async () => {
    const f = fake({ gates: "disabled", parentEnv: { PATH: "/usr/bin", RO_ROLE_CREATE: "enabled", KATANA_RO_ROLE_GATE: "enabled-create" } });
    await expectError(f, "RO_ROLE_CREATE_DISABLED");
    touchedNothing(f);
  });
});

describe("事前の検証（ゲートが有効でも、Docker・DB に触れる前に止まる）", () => {
  it.each<[string, Parameters<typeof fake>[0], TestDbReadOnlyRoleErrorCode]>([
    ["Node のオプション", { execArgv: ["--inspect"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["NODE_OPTIONS", { parentEnv: { NODE_OPTIONS: "--x" } }, "NODE_OPTIONS_PRESENT"],
    ["DOCKER_HOST", { parentEnv: { DOCKER_HOST: "tcp://x" } }, "DOCKER_TARGET_ENV_PRESENT"],
    ["DOCKER_CONTEXT", { parentEnv: { DOCKER_CONTEXT: "default" } }, "DOCKER_TARGET_ENV_PRESENT"],
    ["親の PG*", { parentEnv: { PGHOST: "x" } }, "UNSAFE_PARENT_ENV"],
    [".env.test がない", { testEnv: null }, "TEST_ENV_MISSING"],
    [".env.test の見本の値", { testEnv: { ...TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin" } }, "CREDENTIALS_REJECTED"],
    [".env.test.readonly がない", { roEnv: null }, "READ_ONLY_ENV_MISSING"],
    ["ro の URL が katana_test_user", { roEnv: { ...RO_ENV, KATANA_TEST_RO_DATABASE_URL: APP_URL } }, "READ_ONLY_TARGET_REJECTED"],
    ["ro の URL が開発用DB", { roEnv: { ...RO_ENV, KATANA_TEST_RO_DATABASE_URL: `postgresql://katana_test_ro:${RO_PASSWORD}@localhost:5433/katana` } }, "READ_ONLY_TARGET_REJECTED"],
    ["ro のパスワードがアプリ用と同じ", { roEnv: { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, `${APP_PASSWORD}-padding-padding`), KATANA_TEST_DB_RO_PASSWORD: `${APP_PASSWORD}-padding-padding` }, testEnv: { ...TEST_ENV, DATABASE_URL: APP_URL.replace(APP_PASSWORD, `${APP_PASSWORD}-padding-padding`), KATANA_TEST_DB_PASSWORD: `${APP_PASSWORD}-padding-padding` } }, "READ_ONLY_CREDENTIALS_REJECTED"],
    ["ro の余分なキー", { roEnv: { ...RO_ENV, DATABASE_URL: APP_URL } }, "READ_ONLY_CREDENTIALS_REJECTED"],
    ["SQL ファイルの改変", { readFile: (p) => `${p.endsWith("01-create.sql") ? SQL.create : SQL["grant-sync"]}\nSELECT 1;` }, "SQL_FILE_REJECTED"],
    ["migration の件数", { expectation: () => ({ ...EXPECTATION, inventory: { ...EXPECTATION.inventory, migrations: EXPECTATION.inventory.migrations.slice(1) } }) }, "MIGRATION_COUNT_MISMATCH"],
    ["初回作成でテーブルが16件でない", { expectation: () => ({ ...EXPECTATION, inventory: { ...EXPECTATION.inventory, tables: [...EXPECTATION.inventory.tables, "AddedLater"] } }) }, "TABLE_COUNT_MISMATCH"],
  ])("%s", async (_, options, expected) => {
    const f = fake(options);
    await expectError(f, expected);
    touchedNothing(f);
  });

  it("補完（grant-sync）はテーブルの件数を固定しない（増えたテーブルでも事前の検証を通る）", async () => {
    const f = fake({ argv: ["--grant-sync"], expectation: () => ({ ...EXPECTATION, inventory: { ...EXPECTATION.inventory, tables: [...EXPECTATION.inventory.tables, "AddedLater"] } }) });
    await expect(runTestDbReadOnlyRole(f.deps)).resolves.toEqual({ mode: "dry-run", operation: "grant-sync" });
    expect(f.logs.join("\n")).toContain("expected tables: 17");
  });
});

describe("初回作成（create。ゲートを有効にした偽の実行）", () => {
  it("成功：D1 → F1 → FP0 → A0 → D2 → exec → D3 → F2 → FP1 → R-full の順。固定の引数・環境変数・標準入力", async () => {
    const f = fake();
    expect(await runTestDbReadOnlyRole(f.deps)).toEqual({ mode: "applied", operation: "create", grantedTables: TABLES });
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0", "D2", "exec", "D3", "F2", "FP1", "R1"]);
    const [call] = f.execCalls;
    expect(call.command).toBe("docker");
    expect(call.shell).toBe(false);
    expect(call.args.slice(0, 6)).toEqual(["--context", "desktop-linux", "exec", "-i", "--user", "postgres"]);
    expect(call.args).toContain(DOCKER.containerId);
    expect(call.input).toBe(SQL.create);
    expect(call.env[EXEC_ENV.verifier]).toBe(VERIFIER);
    expect(call.env[EXEC_ENV.verifierSha256]).toBe(sha256Hex(VERIFIER));
    expect(call.env[EXEC_ENV.postmasterStart]).toBe(SERVER.postmasterStartTime);
    expect(call.env[EXEC_ENV.expectedTables]).toBe(TABLES.join(","));
    expect(call.env[EXEC_ENV.grantTargets]).toBe(TABLES.join(","));
    expect(JSON.stringify(call.args)).not.toContain(VERIFIER);
    for (const secret of [RO_PASSWORD, APP_PASSWORD, ADMIN_PASSWORD, RO_URL, APP_URL]) expect(JSON.stringify(call)).not.toContain(secret);
    noSecrets(f);
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbReadOnlyRoleErrorCode, string[]]>([
    ["F1 が状態 C でない", { states: [{ state: "A", reasons: [] } as unknown as TestDatabaseState] }, "DATABASE_STATE_NOT_C", ["D1", "F1"]],
    ["FP0 でロールが既に存在する", { fingerprints: [fp({ created: true, granted: TABLES })] }, "PRECONDITION_FAILED", ["D1", "F1", "FP0"]],
    ["FP0 でテーブルに権限がある", { fingerprints: [fp({ granted: TABLES.slice(0, 1) })] }, "PRECONDITION_FAILED", ["D1", "F1", "FP0"]],
    ["D2 でコンテナが変わった", { dockers: [DOCKER, { ...DOCKER, startedAt: "2026-11-07T00:00:00.000000000Z" }] }, "DOCKER_IDENTITY_MISMATCH", ["D1", "F1", "FP0", "A0", "D2"]],
    ["D2 で Container ID が変わった", { dockers: [DOCKER, { ...DOCKER, containerId: "d".repeat(64) }] }, "DOCKER_IDENTITY_MISMATCH", ["D1", "F1", "FP0", "A0", "D2"]],
  ])("%s なら exec を起動しない", async (_, options, expected, calls) => {
    const f = fake(options);
    await expectError(f, expected);
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.calls).toEqual(calls);
  });

  // ---- A0（変更の前の ACL）。期待と違えば、D2・docker exec の前に止まる ----
  const mutate = (op: ReadOnlyRoleOperation, change: (o: PreChangeAclObservation) => void) => {
    const o = aclObservation(op);
    change(o);
    return o;
  };
  const db = (o: PreChangeAclObservation, name: string) => {
    const found = o.databases.find((d) => d.name === name);
    if (!found) throw new Error(name);
    return found;
  };
  it.each<[string, PreChangeAclObservation, RegExp]>([
    [
      "template1 の ACL が未設定（PUBLIC に TEMPORARY が残る）",
      mutate("create", (o) => Object.assign(db(o, "template1"), { aclNull: true, acl: "PUBLIC:CONNECT:postgres,PUBLIC:TEMPORARY:postgres,postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres", publicTemporary: true })),
      /database template1: aclNull differs.*database template1: publicTemporary differs/,
    ],
    ["template1 の PUBLIC の CREATE", mutate("create", (o) => Object.assign(db(o, "template1"), { publicCreate: true })), /database template1: publicCreate differs/],
    ["postgres の PUBLIC の CONNECT", mutate("create", (o) => Object.assign(db(o, "postgres"), { acl: "PUBLIC:CONNECT:postgres,postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres", publicConnect: true })), /database postgres: acl differs/],
    ["postgres の PUBLIC の TEMPORARY", mutate("create", (o) => Object.assign(db(o, "postgres"), { publicTemporary: true })), /database postgres: publicTemporary differs/],
    ["katana_test の ACL が初期値でない", mutate("create", (o) => Object.assign(db(o, "katana_test"), { aclNull: false })), /database katana_test: aclNull differs/],
    ["katana_test の所有者", mutate("create", (o) => Object.assign(db(o, "katana_test"), { owner: "postgres" })), /database katana_test: owner differs/],
    ["想定外の DB", mutate("create", (o) => o.databases.push({ ...db(o, "template1"), name: "other" })), /the databases are not the expected ones/],
    ["DB が足りない", mutate("create", (o) => o.databases.splice(o.databases.findIndex((d) => d.name === "postgres"), 1)), /the databases are not the expected ones/],
    ["public の PUBLIC の CREATE", mutate("create", (o) => Object.assign(o.schemas[0], { acl: "PUBLIC:CREATE:pg_database_owner,PUBLIC:USAGE:pg_database_owner,pg_database_owner:CREATE:pg_database_owner,pg_database_owner:USAGE:pg_database_owner", publicCreate: true })), /schema public: acl differs/],
    ["public 以外のスキーマ", mutate("create", (o) => o.schemas.push({ ...o.schemas[0], name: "extra" })), /the schemas are not the expected ones/],
    ["付与の権限（GRANTABLE）がある", mutate("create", (o) => Object.assign(o.schemas[0], { acl: o.schemas[0].acl.replace("PUBLIC:USAGE:pg_database_owner", "PUBLIC:USAGE:pg_database_owner:GRANTABLE") })), /schema public: acl differs/],
  ])("A0：%s なら PRE_CHANGE_ACL_MISMATCH。D2・exec の前に止まる", async (_, acl, message) => {
    const f = fake({ acl });
    const error = await expectError(f, "PRE_CHANGE_ACL_MISMATCH");
    expect(error.message).toMatch(message);
    expect(error.message).toContain("Nothing was changed.");
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0"]);
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("A0：grant-sync の期待値（katana_test の TEMPORARY を取り上げた後）は、create では一致しない", async () => {
    const f = fake({ acl: aclObservation("grant-sync") });
    await expectError(f, "PRE_CHANGE_ACL_MISMATCH");
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("A0：接続・照会の失敗は PRE_CHANGE_ACL_CHECK_FAILED。D2・exec の前に止まる", async () => {
    const f = fake({ acl: Object.assign(new Error("x"), { code: "CHECK_QUERY_FAILED" }) });
    const error = await expectError(f, "PRE_CHANGE_ACL_CHECK_FAILED");
    expect(error.message).toContain("CHECK_QUERY_FAILED");
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0"]);
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("A0：katana_test_user の検証済みの URL と、D1・F1 の識別情報を渡す", async () => {
    const f = fake();
    await runTestDbReadOnlyRole(f.deps);
    expect(f.acl).toHaveBeenCalledTimes(1);
    const [input] = f.acl.mock.calls[0];
    expect(input.databaseUrl).toBe(APP_URL);
    expect(input.expectedServer).toEqual({ docker: DOCKER, server: SERVER });
  });

  it("exec が SQL のエラー（3）で、FP1 が FP0 と同じなら EXEC_FAILED。事後の検査は行い、R-full は行わない。出力の秘密は伏せる", async () => {
    const f = fake({ fingerprints: [fp(), fp()], execResult: { kind: "exit", code: 3, signal: null, stdout: "", stderr: `ERROR: katana-ro-role: refusing ${VERIFIER} ${RO_PASSWORD} ${APP_URL}` } });
    const error = await expectError(f, "EXEC_FAILED");
    expect(error.message).toContain("rolled back");
    expect(error.message).toContain("katana-ro-role: refusing");
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0", "D2", "exec", "D3", "F2", "FP1"]);
  });

  it("exec が接続の切断（2）なら、COMMIT したかは不明と表示し、成功にしない", async () => {
    const f = fake({ fingerprints: [fp(), fp()], execResult: { kind: "exit", code: 2, signal: null, stdout: "", stderr: "" } });
    const error = await expectError(f, "EXEC_FAILED");
    expect(error.message).toContain("whether the transaction committed is unknown");
  });

  it.each<[string, ReadOnlyRoleExecResult]>([
    ["起動の失敗", { kind: "spawn-error", errorCode: "ENOENT" }],
    ["タイムアウト", { kind: "timeout", stdout: "", stderr: "" }],
    ["シグナル", { kind: "exit", code: null, signal: "SIGKILL", stdout: "", stderr: "" }],
    ["docker exec 自体の失敗（125）", { kind: "exit", code: 125, signal: null, stdout: "", stderr: "" }],
  ])("%s でも事後の検査を行い、成功にしない", async (_, execResult) => {
    const f = fake({ fingerprints: [fp(), fp()], execResult });
    await expectError(f, "EXEC_FAILED");
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0", "D2", "exec", "D3", "F2", "FP1"]);
  });

  it("exec が失敗したのにカタログが変わっていれば EXEC_FAILED_STATE_CHANGED（自動では直さない）", async () => {
    const f = fake({ fingerprints: [fp(), fp({ created: true, granted: TABLES })], execResult: { kind: "exit", code: 2, signal: null, stdout: "", stderr: "" } });
    await expectError(f, "EXEC_FAILED_STATE_CHANGED");
  });

  it("exec が成功しても、想定外の差分（large object）があれば POST_FINGERPRINT_MISMATCH。R-full は行わない", async () => {
    const f = fake({ fingerprints: [fp(), fp({ created: true, granted: TABLES, largeObject: true })] });
    await expectError(f, "POST_FINGERPRINT_MISMATCH");
    expect(f.role).not.toHaveBeenCalled();
  });

  it("exec が成功しても、R-full が失敗すれば READ_ONLY_ROLE_FULL_FAILED", async () => {
    const bad = observation();
    bad.snapshot.memberships.push("katana_test_user");
    const f = fake({ observations: [bad] });
    await expectError(f, "READ_ONLY_ROLE_FULL_FAILED");
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbReadOnlyRoleErrorCode]>([
    ["D3 でコンテナが変わった", { dockers: [DOCKER, DOCKER, { ...DOCKER, restartCount: 1 }] }, "POST_IDENTITY_MISMATCH"],
    ["F2 が状態 C でない", { states: [STATE_C, { state: "B", reasons: ["x"] } as unknown as TestDatabaseState] }, "POST_STATE_MISMATCH"],
  ])("exec の後の %s は、成功にしない", async (_, options, expected) => {
    const f = fake(options);
    await expectError(f, expected);
    expect(f.exec).toHaveBeenCalledTimes(1);
  });
});

describe("読み取り専用の事前検証（--preflight-create。偽の Docker・DB）", () => {
  const preflight = (o: Parameters<typeof fake>[0] = {}) => fake({ gates: "disabled", ...o, argv: ["--preflight-create"] });

  it("引数は --preflight-create の単独だけ。--apply・変更の操作との併用・未知の形は、何にも触れる前に ARGUMENTS_INVALID", async () => {
    expect(parseTestDbReadOnlyRoleArgs(["--preflight-create"])).toEqual({ operation: "create", apply: false, preflight: true });
    for (const argv of [
      ["--preflight-create", "--apply"],
      ["--apply", "--preflight-create"],
      ["--preflight-create", "--create"],
      ["--create", "--preflight-create"],
      ["--preflight-create", "--grant-sync"],
      ["--preflight-create", "--preflight-create"],
      ["--preflight-grant-sync"],
      ["--preflight"],
      ["--preflight-create", "--sql", "SELECT 1"],
    ]) {
      const f = fake({ argv, gates: "both" });
      await expectError(f, "ARGUMENTS_INVALID");
      touchedNothing(f);
    }
  });

  it("成功：ゲートが6つとも無効のままで、D1 → F1 → FP0 → A0 → D2 だけ。docker exec・ro の接続・検証子の作成はしない", async () => {
    const createVerifier = vi.fn(() => VERIFIER);
    const f = preflight();
    f.deps.createVerifier = createVerifier;
    expect(await runTestDbReadOnlyRole(f.deps)).toEqual({ mode: "preflight", operation: "create" });
    expect(f.calls).toEqual(["D1", "F1", "FP0", "A0", "D2"]);
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.role).not.toHaveBeenCalled();
    expect(createVerifier).not.toHaveBeenCalled();
    expect(f.deps.createGate).toBe(RO_ROLE_CREATE_DISABLED);
    expect(f.deps.grantSyncGate).toBe(RO_ROLE_GRANT_SYNC_DISABLED);
    const log = f.logs.join("\n");
    expect(log).toContain("preflight of create passed");
    expect(log).toContain("nothing was changed and docker exec was not run");
    noSecrets(f);
  });

  it("DB への接続は、katana_test_user の読み取り専用の検査（F1・FP0・A0）だけ。どれも D1・F1 の識別情報を受け取る", async () => {
    const f = preflight();
    await runTestDbReadOnlyRole(f.deps);
    expect(f.inspectDb).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.acl).toHaveBeenCalledTimes(1);
    for (const mock of [f.inspectDb, f.audit, f.acl] as Mock[]) expect(mock.mock.calls[0][0].databaseUrl).toBe(APP_URL);
    expect(f.audit.mock.calls[0][0].expectedServer).toEqual({ docker: DOCKER, server: SERVER });
    expect(f.acl.mock.calls[0][0].expectedServer).toEqual({ docker: DOCKER, server: SERVER });
  });

  it("変更の前の検査は --create --apply と同じ手順（呼び出しの順序が D2 まで一致）", async () => {
    const p = preflight();
    await runTestDbReadOnlyRole(p.deps);
    const a = fake({ gates: "create", argv: ["--create", "--apply"] });
    await runTestDbReadOnlyRole(a.deps);
    expect(a.calls.slice(0, p.calls.length)).toEqual(p.calls);
    expect(a.calls[p.calls.length]).toBe("exec");
  });

  it.each<[string, Parameters<typeof fake>[0], TestDbReadOnlyRoleErrorCode, string[]]>([
    ["F1 が状態 C でない（A0 に進まない）", { states: [{ state: "B", reasons: ["x"] } as unknown as TestDatabaseState] }, "DATABASE_STATE_NOT_C", ["D1", "F1"]],
    ["FP0 でロールが既に存在する", { fingerprints: [fp({ created: true, granted: TABLES })] }, "PRECONDITION_FAILED", ["D1", "F1", "FP0"]],
    ["FP0 でテーブルに権限がある", { fingerprints: [fp({ granted: TABLES.slice(0, 1) })] }, "PRECONDITION_FAILED", ["D1", "F1", "FP0"]],
    [
      "A0 で template1 の PUBLIC に TEMPORARY",
      { acl: (() => { const o = aclObservation("create"); Object.assign(o.databases.find((d) => d.name === "template1") ?? {}, { publicTemporary: true }); return o; })() },
      "PRE_CHANGE_ACL_MISMATCH",
      ["D1", "F1", "FP0", "A0"],
    ],
    ["A0 で想定外のスキーマ", { acl: (() => { const o = aclObservation("create"); o.schemas.push({ ...o.schemas[0], name: "extra" }); return o; })() }, "PRE_CHANGE_ACL_MISMATCH", ["D1", "F1", "FP0", "A0"]],
    ["A0 で想定外の DB", { acl: (() => { const o = aclObservation("create"); o.databases.push({ ...o.databases[0], name: "extra" }); return o; })() }, "PRE_CHANGE_ACL_MISMATCH", ["D1", "F1", "FP0", "A0"]],
    ["A0 の照会の失敗", { acl: Object.assign(new Error("x"), { code: "CHECK_QUERY_FAILED" }) }, "PRE_CHANGE_ACL_CHECK_FAILED", ["D1", "F1", "FP0", "A0"]],
    ["D2 でコンテナが変わった", { dockers: [DOCKER, { ...DOCKER, restartCount: 1 }] }, "DOCKER_IDENTITY_MISMATCH", ["D1", "F1", "FP0", "A0", "D2"]],
  ])("%s なら成功にしない", async (_, options, expected, calls) => {
    const f = preflight(options);
    await expectError(f, expected);
    expect(f.calls).toEqual(calls);
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.role).not.toHaveBeenCalled();
  });

  it("Docker・DB の識別・照会の失敗は、固定のエラーコードで止まる（秘密情報を含めない）", async () => {
    const d = preflight();
    d.docker.mockRejectedValueOnce(Object.assign(new Error(`boom ${APP_URL}`), { code: "DOCKER_FAILED" }));
    await expectError(d, "DOCKER_IDENTITY_FAILED");
    expect(d.inspectDb).not.toHaveBeenCalled();

    const i = preflight();
    i.inspectDb.mockRejectedValueOnce(Object.assign(new Error(`boom ${APP_PASSWORD}`), { code: "CONNECT_FAILED" }));
    const error = await expectError(i, "STATE_CHECK_FAILED");
    expect(error.message).toContain("CONNECT_FAILED");
    expect(i.audit).not.toHaveBeenCalled();
    expect(i.acl).not.toHaveBeenCalled();

    const a = preflight();
    a.audit.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "QUERY_FAILED" }));
    await expectError(a, "CATALOG_CHECK_FAILED");
    expect(a.acl).not.toHaveBeenCalled();
    for (const f of [d, i, a]) expect(f.exec).not.toHaveBeenCalled();
  });

  it("事前の検証（認証情報・SQL ファイル・期待値）に失敗すれば、Docker・DB に触れない", async () => {
    for (const options of [
      { roEnv: null },
      { testEnv: null },
      { readFile: (p: string) => `${p.endsWith("01-create.sql") ? SQL.create : SQL["grant-sync"]}\nSELECT 1;` },
      { parentEnv: { PATH: "/usr/bin", PGHOST: "elsewhere" } },
      { parentEnv: { PATH: "/usr/bin", DOCKER_HOST: "tcp://elsewhere" } },
    ] as Parameters<typeof fake>[0][]) {
      const f = preflight(options);
      await expect(runTestDbReadOnlyRole(f.deps)).rejects.toBeInstanceOf(TestDbReadOnlyRoleError);
      touchedNothing(f);
    }
  });

  it("既存の経路は変わらない：予行は Docker・DB に触れず、ゲートが無効の --apply は Docker・DB の前に止まる", async () => {
    const dry = fake({ argv: ["--create"], gates: "disabled" });
    expect(await runTestDbReadOnlyRole(dry.deps)).toEqual({ mode: "dry-run", operation: "create" });
    touchedNothing(dry);
    const apply = fake({ argv: ["--create", "--apply"], gates: "disabled" });
    await expectError(apply, "RO_ROLE_CREATE_DISABLED");
    touchedNothing(apply);
    const sync = fake({ argv: ["--grant-sync", "--apply"], gates: "disabled" });
    await expectError(sync, "RO_ROLE_GRANT_SYNC_DISABLED");
    touchedNothing(sync);
  });
});

describe("補完（grant-sync。ゲートを有効にした偽の実行）", () => {
  const added = TABLES.filter((t) => t !== "_prisma_migrations").slice(0, 2);
  const before = TABLES.filter((t) => !added.includes(t));

  it("補完の対象が0件なら、docker exec をせず、R-full が通ったときだけ成功", async () => {
    const f = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: TABLES })], observations: [observation(), observation()] });
    expect(await runTestDbReadOnlyRole(f.deps)).toEqual({ mode: "nothing-to-do", operation: "grant-sync" });
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["D1", "F1", "FP0", "R1", "R2"]);
  });

  it("補完の対象が0件でも、R-full が失敗すれば成功にしない（exec もしない）", async () => {
    const bad = observation();
    bad.snapshot.role.defaultReadOnly = "off";
    // R-base は default_transaction_read_only も検査するので、R-base の時点で止まる
    const f = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: TABLES })], observations: [bad] });
    await expectError(f, "READ_ONLY_ROLE_BASE_FAILED");
    expect(f.exec).not.toHaveBeenCalled();
    // R-base は通り、R-full（2回目の接続）だけが失敗する場合
    const later = observation();
    later.dependencies.push({ database: "template1", catalog: "other", subId: 0, type: "o", objectName: null });
    const g = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: TABLES })], observations: [observation(), later] });
    await expectError(g, "READ_ONLY_ROLE_FULL_FAILED");
    expect(g.exec).not.toHaveBeenCalled();
  });

  it("不足があれば、補完の対象だけを grant_targets に渡し、補完したテーブルの ACL だけの差分で成功", async () => {
    const f = fake({
      argv: ["--grant-sync", "--apply"],
      fingerprints: [fp({ created: true, granted: before }), fp({ created: true, granted: TABLES })],
      observations: [observation(before), observation()],
    });
    expect(await runTestDbReadOnlyRole(f.deps)).toEqual({ mode: "applied", operation: "grant-sync", grantedTables: [...added].sort() });
    expect(f.calls).toEqual(["D1", "F1", "FP0", "R1", "A0", "D2", "exec", "D3", "F2", "FP1", "R2"]);
    const [call] = f.execCalls;
    expect(call.input).toBe(SQL["grant-sync"]);
    expect(call.env[EXEC_ENV.grantTargets]).toBe([...added].sort().join(","));
    expect(call.env[EXEC_ENV.expectedTables]).toBe(TABLES.join(","));
    expect(call.env[EXEC_ENV.verifier]).toBeUndefined();
    expect(call.args).not.toContain(EXEC_ENV.verifier);
  });

  it("A0 が期待と違えば（template1 の TEMPORARY）、R-base の後・exec の前に止まる", async () => {
    const acl = aclObservation("grant-sync");
    Object.assign(acl.databases.find((d) => d.name === "template1") ?? {}, { publicTemporary: true });
    const f = fake({
      argv: ["--grant-sync", "--apply"],
      fingerprints: [fp({ created: true, granted: before })],
      observations: [observation(before)],
      acl,
    });
    await expectError(f, "PRE_CHANGE_ACL_MISMATCH");
    expect(f.calls).toEqual(["D1", "F1", "FP0", "R1", "A0"]);
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("補完の対象が0件のときは、変更しないので A0 も行わない", async () => {
    const f = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: TABLES })], observations: [observation(), observation()] });
    await runTestDbReadOnlyRole(f.deps);
    expect(f.acl).not.toHaveBeenCalled();
  });

  it("R-base が失敗すれば exec しない（既存の権限は上書きしない）", async () => {
    const bad = observation(before);
    bad.snapshot.tables[0].insert = true;
    const f = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: before })], observations: [bad] });
    await expectError(f, "READ_ONLY_ROLE_BASE_FAILED");
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("R-base の補完の対象と、FP0 の ACL が未設定のテーブルが食い違えば GRANT_TARGETS_MISMATCH", async () => {
    const f = fake({ argv: ["--grant-sync", "--apply"], fingerprints: [fp({ created: true, granted: TABLES })], observations: [observation(before)] });
    await expectError(f, "GRANT_TARGETS_MISMATCH");
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("補完の後に、補完していないテーブルまで変わっていれば POST_FINGERPRINT_MISMATCH", async () => {
    const f = fake({
      argv: ["--grant-sync", "--apply"],
      fingerprints: [fp({ created: true, granted: before }), fp({ created: true, granted: TABLES, largeObject: true })],
      observations: [observation(before), observation()],
    });
    await expectError(f, "POST_FINGERPRINT_MISMATCH");
  });
});

describe("スクリプトの配線と、ほかの経路への影響（静的な検査）", () => {
  const script = code("scripts/testdb-ro-role.mts");

  it("スクリプトのゲートは、固定の無効値の2行だけ（引数・環境変数から決めない）", () => {
    const gateLines = script.split("\n").filter((l) => /^\s*(createGate|grantSyncGate):/.test(l));
    expect(gateLines).toEqual(["  createGate: RO_ROLE_CREATE_DISABLED,", "  grantSyncGate: RO_ROLE_GRANT_SYNC_DISABLED,"]);
    expect(script).not.toMatch(/enabled-create|enabled-grant-sync/);
    expect(script.match(/process\.argv/g)).toHaveLength(1);
    expect(script.match(/process\.env/g)).toHaveLength(1);
  });

  it("exec は shell なし・コマンドは docker だけ・SQL は標準入力。汎用の SQL・任意の引数の経路はない", () => {
    expect(script).toContain('if (command !== "docker" || options.shell !== false)');
    expect(script).toMatch(/spawn\(command, \[\.\.\.args\], \{ cwd: options\.cwd, env: options\.env as NodeJS\.ProcessEnv, shell: false, stdio: \["pipe", "pipe", "pipe"\] \}\)/);
    expect(script).toContain("child.stdin.end(options.input");
    expect(script).not.toMatch(/execSync|exec\(|shell: true/);
    const lib = code("lib/testing/testDbReadOnlyRoleRunner.ts");
    expect(lib).toContain('deps.exec("docker", args, { cwd: root, env, shell: false, input: sql, timeoutMs: RO_ROLE_EXEC_TIMEOUT_MS })');
  });

  it("本体のモジュールは、DB ドライバ・Docker のコマンド・子プロセスを直接読み込まない", () => {
    for (const file of ["lib/testing/testDbReadOnlyRole.ts", "lib/testing/testDbReadOnlyRoleRunner.ts"]) {
      const source = code(file);
      for (const forbidden of ["child_process", '"pg"', "runDockerCommand", "@prisma/client", "@/lib/prisma", "PRISMA_CLI_ENTRY", "writeFile"]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
      // testDbDocker（子プロセスを読み込む）・testDbConnection（pg を読み込む）は import しない（コメントでの言及は除く）
      const imports = [...source.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm)].map((m) => m[1]);
      expect(imports.some((spec) => /testDbDocker|testDbConnection/.test(spec)), file).toBe(false);
    }
  });

  it("npm のスクリプトは予行の2つだけ。--apply 付きの npm スクリプトはない", () => {
    const pkg = JSON.parse(code("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:ro-role:create"]).toBe("node scripts/testdb-ro-role.mts --create");
    expect(pkg.scripts["testdb:ro-role:grant-sync"]).toBe("node scripts/testdb-ro-role.mts --grant-sync");
    expect(pkg.scripts["testdb:ro-role:preflight-create"]).toBe("node scripts/testdb-ro-role.mts --preflight-create");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("testdb-ro-role.mts"))).toHaveLength(3);
    expect(Object.values(pkg.scripts).some((s) => s.includes("--apply"))).toBe(false);
  });

  it("既存の4つの固定ゲートは無効のまま（スクリプトの値も変わらない）", () => {
    for (const gate of [LIVE_DATABASE_DISABLED, CHECKSUM_DATABASE_DISABLED, CATALOG_AUDIT_DATABASE_DISABLED, SCHEMA_DIFF_DISABLED]) {
      expect(gate).toEqual({ mode: "disabled" });
      expect(gate).not.toBe(RO_ROLE_CREATE_DISABLED);
      expect(gate).not.toBe(RO_ROLE_GRANT_SYNC_DISABLED);
    }
    expect(code("scripts/testdb-migrate.mts")).toMatch(/^ {2}liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(code("scripts/testdb-checksums.mts")).toMatch(/^ {2}checksumDatabase: CHECKSUM_DATABASE_DISABLED,$/m);
    expect(code("scripts/testdb-catalog.mts")).toMatch(/^ {2}catalogDatabase: CATALOG_AUDIT_DATABASE_DISABLED,$/m);
    expect(EXPECTED_RO_ROLE_MIGRATION_COUNT).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it("既存の Docker の許可リスト（up・down・読み取り）に exec を足していない", () => {
    const docker = code("lib/testing/testDbDocker.ts");
    expect(docker).not.toMatch(/"exec"/);
    expect(docker).not.toContain("testDbReadOnlyRole");
  });

  it(".env.test.example は、ro のキーを有効な行として持たない（コメントの説明だけ。.env.test の未知のキーの拒否を変えない）", () => {
    const example = code(".env.test.example");
    const keys = example.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    expect(keys).toEqual(["DATABASE_URL", "KATANA_TEST_DB_PASSWORD", "KATANA_TEST_DB_ADMIN_PASSWORD"]);
    expect(example).toContain(".env.test.readonly");
  });
});
