import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { SCHEMA_DIFF_RO_URL_SHA256_ENV, schemaDiffUrlSha256 } from "../db/prismaCliGuard";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck";
import {
  SCHEMA_DIFF_DISABLED,
  SCHEMA_DIFF_SCOPE_NOTE,
  SchemaDiffError,
  type SchemaDiffErrorCode,
  type SchemaDiffInterrupts,
  type SchemaDiffInterruptSignal,
  type SchemaDiffProcessResult,
} from "./schemaDiff";
import { CATALOG_FINGERPRINT_SECTIONS, type CatalogFingerprint, loadCatalogAuditExpectation, type ReadOnlyRoleSnapshot } from "./testDbCatalogAudit";
import { EXPECTED_MIGRATION_COUNT } from "./testDbChecksums";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import type { InspectDatabase, ReadDockerIdentity } from "./testDbMigrate";
import {
  EXPECTED_PRE_CHANGE_SCHEMAS,
  EXPECTED_PRE_CHANGE_SYSTEM_DATABASES,
  EXPECTED_PRE_CHANGE_TEST_DATABASE,
  EXPECTED_ROLE_CONFIG_MD5,
  expectedReadOnlyRoleTables,
  type PreChangeAclObservation,
  type ReadOnlyRoleObservation,
  sha256Hex,
} from "./testDbReadOnlyRole";
import {
  decideSchemaDiffVerdict,
  EXPECTED_SCHEMA_DIFF_MIGRATION_COUNT,
  parseTestDbSchemaDiffArgs,
  type PostCheckResult,
  runTestDbSchemaDiff,
  type TestDbSchemaDiffDeps,
} from "./testDbSchemaDiffRunner";
import type { TestDatabasePrivileges, TestDatabaseState } from "./testDbState";

// Prisma CLI・schema engine を起動せず、Docker にも DB にも接続しない。Docker・DB・カタログ・読み取り専用ロールの検査・子プロセスは、
// すべて偽の関数で置き換える。期待値はリポジトリのファイルを読むだけ。CLI・engine の SHA-256 は、実体のファイルを読んで照合する（実行しない）
const ROOT = "/fake/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const EXEC_PATH = "/fake/bin/node";

const APP_PASSWORD = "schema_diff_app_dummy_password_0123456789";
const ADMIN_PASSWORD = "schema-diff-admin-dummy-password";
const RO_PASSWORD = "schema_diff_ro_dummy_password_0123456789";
const APP_URL = `postgresql://katana_test_user:${APP_PASSWORD}@127.0.0.1:5434/katana_test`;
const RO_URL = `postgresql://katana_test_ro:${RO_PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "schema-diff-dev-dummy";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [APP_PASSWORD, ADMIN_PASSWORD, RO_PASSWORD, APP_URL, RO_URL, DEV_PASSWORD, DEV_URL, "postgresql://katana", "postgres://"];
const TEST_ENV = { DATABASE_URL: APP_URL, KATANA_TEST_DB_PASSWORD: APP_PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const RO_ENV = { KATANA_TEST_RO_DATABASE_URL: RO_URL, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD };

const EXPECTATION = loadCatalogAuditExpectation(REPO_ROOT);
const TABLES = expectedReadOnlyRoleTables(EXPECTATION);
const readBinary = (p: string) => readFileSync(path.join(REPO_ROOT, path.relative(ROOT, p)));

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

// ---- 作成後の期待状態の fingerprint（testDbReadOnlyRoleRunner.test.ts の --verify-created と同じ組み立て。実装の定数を使わずリテラルで） ----
const TABLE_ACL = "{katana_test_user=arwdDxt/katana_test_user,katana_test_ro=r/katana_test_user}";
const DB_ACL = "{=c/katana_test_user,katana_test_user=CTc/katana_test_user}";

function entry(section: string, fields: Record<string, unknown>): readonly [string, string] {
  const spec = CATALOG_FINGERPRINT_SECTIONS[section];
  return [JSON.stringify(spec.key.map((k) => fields[k])), JSON.stringify(Object.keys(spec.fields).sort().map((f) => [f, fields[f] ?? null]))] as const;
}

function createdFp(mutate?: (s: Record<string, (readonly [string, string])[]>) => void): CatalogFingerprint {
  const flags = { schema: "public", persistence: "p", rowSecurity: false, forceRowSecurity: false, owner: "katana_test_user" };
  const roleFlags = { superuser: false, inherit: true, createRole: false, createDb: false, login: true, replication: false, bypassRls: false, connectionLimit: -1, config: null };
  const enumValues = EXPECTATION.enums.status === "supported" ? EXPECTATION.enums.enums : {};
  const typeEntry = (name: string, kind: string) => entry("types", { schema: "public", name, kind, owner: "katana_test_user", acl: null });
  const s: Record<string, (readonly [string, string])[]> = Object.fromEntries(Object.keys(CATALOG_FINGERPRINT_SECTIONS).map((n) => [n, []]));
  s.database = [entry("database", { name: "katana_test", owner: "katana_test_user", acl: DB_ACL, comment: "katana-test-db" })];
  s.schemas = [entry("schemas", { name: "public", owner: "pg_database_owner", acl: "{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}" })];
  s.extensions = [entry("extensions", { name: "plpgsql", version: "1.0", schema: "pg_catalog" })];
  s.relations = TABLES.flatMap((t) => [entry("relations", { ...flags, name: t, kind: "r", acl: TABLE_ACL }), entry("relations", { ...flags, name: `${t}_pkey`, kind: "i", acl: null })]);
  s.indexes = TABLES.map((t) => entry("indexes", { schema: "public", name: `${t}_pkey`, table: t, definition: "x", primary: true, unique: true, valid: true }));
  s.constraints = TABLES.map((t) => entry("constraints", { schema: "public", table: t, name: `${t}_pkey`, type: "p", definition: "PRIMARY KEY (id)", deferrable: false, deferred: false, validated: true }));
  s.columns = TABLES.map((t) => entry("columns", { schema: "public", table: t, name: "id", position: 1, type: "text", notNull: true, identity: "", generated: "", collation: "default", acl: null }));
  s.types = [...TABLES.flatMap((t) => [typeEntry(t, "c"), typeEntry(`_${t}`, "b")]), ...EXPECTATION.inventory.enums.flatMap((e) => [typeEntry(e, "e"), typeEntry(`_${e}`, "b")])];
  s.enumValues = Object.entries(enumValues).flatMap(([e, values]) => values.map((value, i) => entry("enumValues", { schema: "public", enum: e, value, position: i + 1 })));
  s.roles = [
    entry("roles", { name: "postgres", superuser: true, inherit: true, createRole: true, createDb: true, login: true, replication: true, bypassRls: true, connectionLimit: -1, config: null }),
    entry("roles", { ...roleFlags, name: "katana_test_user" }),
    entry("roles", { ...roleFlags, name: "katana_test_ro", inherit: false, config: EXPECTED_ROLE_CONFIG_MD5 }),
  ];
  s.dbRoleSettings = [entry("dbRoleSettings", { databaseScope: "all", database: "", roleScope: "one", role: "katana_test_ro", configHash: EXPECTED_ROLE_CONFIG_MD5 })];
  s.roleMemberships = ["pg_read_all_settings", "pg_read_all_stats", "pg_stat_scan_tables"].map((role) => entry("roleMemberships", { role, member: "pg_monitor", admin: false }));
  mutate?.(s);
  for (const [name, entries] of Object.entries(s)) s[name] = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { meaning: "observed-catalog-definition", sha256: sha256Hex(JSON.stringify(s)), sections: s };
}

/** katana_test_ro の観測（SELECT だけ。o.write で書き込み権限を1つ足す） */
function observation(o: { write?: boolean } = {}): ReadOnlyRoleObservation {
  const snapshot: ReadOnlyRoleSnapshot = {
    role: { currentUser: "katana_test_ro", sessionUser: "katana_test_ro", superuser: false, inherit: false, createRole: false, createDb: false, replication: false, bypassRls: false, defaultReadOnly: "on" },
    memberships: [],
    ownership: ["relation", "type", "schema", "routine", "database", "large object", "default privileges"].map((kind) => ({ kind, count: 0 })),
    database: { databaseCreate: false, databaseTemporary: false, schemaCreate: false, schemaUsage: true },
    tables: TABLES.map((table, i) => ({ table, select: true, insert: o.write === true && i === 0, update: false, delete: false, truncate: false, references: false, trigger: false })),
    sequences: [],
    catalogColumns: TABLES.map((table) => ({ table, column: "id" })),
    visibleColumns: TABLES.map((table) => ({ table, column: "id" })),
  };
  return {
    snapshot,
    dependencies: TABLES.map((objectName) => ({ database: "katana_test", catalog: "pg_class", subId: 0, type: "a", objectName })),
    databases: [
      { name: "katana_test", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "postgres", allowConnections: true, connect: false, temporary: false, create: false, explicitGrants: 0 },
      { name: "template0", allowConnections: false, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "template1", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
    ],
    tableAcl: TABLES.map((table) => ({ table, aclNull: false })),
  };
}

/** A1 の観測（作成後の期待値どおり） */
const createdAcl = (): PreChangeAclObservation => ({
  databases: [...EXPECTED_PRE_CHANGE_SYSTEM_DATABASES, EXPECTED_PRE_CHANGE_TEST_DATABASE["grant-sync"]].map((d) => ({ ...d })),
  schemas: EXPECTED_PRE_CHANGE_SCHEMAS.map((n) => ({ ...n })),
});

const exit = (code: number | null, stdout = "", stderr = "", signal: string | null = null): SchemaDiffProcessResult => ({ kind: "exit", code, signal, stdout, stderr, processGroup: "stopped" });

type Step<T> = T | Error;
type Fake = {
  deps: TestDbSchemaDiffDeps;
  docker: Mock<ReadDockerIdentity>;
  inspectDb: Mock<InspectDatabase>;
  audit: Mock<TestDbSchemaDiffDeps["runAudit"]>;
  role: Mock<TestDbSchemaDiffDeps["checkReadOnlyRole"]>;
  acl: Mock<TestDbSchemaDiffDeps["checkAcl"]>;
  spawn: Mock<TestDbSchemaDiffDeps["spawnCapture"]>;
  readBinary: Mock<TestDbSchemaDiffDeps["readBinary"]>;
  logs: string[];
  calls: string[];
  interrupts: SchemaDiffInterrupts;
};

function fake(
  o: {
    argv?: readonly string[];
    enabled?: boolean;
    testEnv?: Record<string, string | undefined> | null;
    roEnv?: Record<string, string | undefined> | null;
    devEnv?: Record<string, string | undefined>;
    parentEnv?: Record<string, string | undefined>;
    execArgv?: string[];
    platform?: string;
    missingPaths?: readonly string[];
    readBinary?: (p: string) => Uint8Array;
    dockers?: readonly Step<TestDbDockerIdentity>[];
    inspections?: readonly Step<{ state: TestDatabaseState; server?: TestDatabaseServerIdentity }>[];
    fingerprints?: readonly Step<CatalogFingerprint>[];
    auditVerdict?: "passed" | "failed";
    observations?: readonly Step<ReadOnlyRoleObservation>[];
    acl?: Step<PreChangeAclObservation>;
    result?: SchemaDiffProcessResult | Error;
    buildCommand?: TestDbSchemaDiffDeps["buildCommand"];
    /** この段階（D1・F1・…・CLI・D3・…）の実行中に、親のプロセスが中断（SIGINT・SIGTERM）を受ける */
    interruptAt?: string;
    interruptSignal?: SchemaDiffInterruptSignal;
    /** 中断で、その段階が失敗する（Ctrl-C で Docker のコマンドが止まったときなど） */
    interruptFails?: boolean;
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  let received: SchemaDiffInterruptSignal | undefined;
  const interrupts: SchemaDiffInterrupts = { received: () => received, subscribe: () => () => {} };
  /** 段階の記録。interruptAt の段階なら、中断を受けたことにする（interruptFails なら、その段階を失敗させる） */
  const step = (label: string) => {
    calls.push(label);
    if (label === o.interruptAt) {
      received ??= o.interruptSignal ?? "SIGINT";
      if (o.interruptFails) throw new Error(`interrupted ${APP_URL}`);
    }
  };
  const n = { docker: 0, inspect: 0, audit: 0, role: 0 };
  const pick = <T>(list: readonly Step<T>[] | undefined, index: number, fallback: T): T => {
    const value = list === undefined ? fallback : list[Math.min(index, list.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  const docker = vi.fn<ReadDockerIdentity>(async () => {
    n.docker += 1;
    step(`D${n.docker}`);
    return { ...pick(o.dockers, n.docker - 1, DOCKER) };
  });
  const inspectDb = vi.fn<InspectDatabase>(async () => {
    n.inspect += 1;
    step(`F${n.inspect}`);
    const next = pick(o.inspections, n.inspect - 1, { state: STATE_C });
    return { state: next.state, privileges: PRIVILEGES, server: { ...(next.server ?? SERVER) } };
  });
  const audit = vi.fn<TestDbSchemaDiffDeps["runAudit"]>(async () => {
    n.audit += 1;
    step(`FP${n.audit}`);
    return { report: { verdict: o.auditVerdict ?? "passed", findings: [] }, fingerprint: pick(o.fingerprints, n.audit - 1, createdFp()) };
  });
  const role = vi.fn<TestDbSchemaDiffDeps["checkReadOnlyRole"]>(async () => {
    n.role += 1;
    step(`R${n.role}`);
    return pick(o.observations, n.role - 1, observation());
  });
  const acl = vi.fn<TestDbSchemaDiffDeps["checkAcl"]>(async () => {
    step("A1");
    return pick(o.acl === undefined ? undefined : [o.acl], 0, createdAcl());
  });
  const spawn = vi.fn<TestDbSchemaDiffDeps["spawnCapture"]>(async () => {
    step("CLI");
    const r = o.result ?? exit(0, "No difference detected.");
    if (r instanceof Error) throw r;
    return r;
  });
  const readBinaryMock = vi.fn<TestDbSchemaDiffDeps["readBinary"]>((p) => {
    calls.push("hash");
    return (o.readBinary ?? readBinary)(p);
  });
  const deps: TestDbSchemaDiffDeps = {
    root: ROOT,
    argv: o.argv ?? ["--live"],
    execArgv: o.execArgv ?? [],
    execPath: EXEC_PATH,
    platform: o.platform ?? "darwin",
    arch: "arm64",
    parentEnv: o.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/test" },
    readEnvFile: (file) => {
      if (file.endsWith(".env.test.readonly")) return o.roEnv === null ? undefined : (o.roEnv ?? RO_ENV);
      if (file.endsWith(".env.test")) return o.testEnv === null ? undefined : (o.testEnv ?? TEST_ENV);
      if (file.endsWith(".env")) return o.devEnv ?? { DATABASE_URL: DEV_URL };
      return undefined;
    },
    pathExists: (p) => !(o.missingPaths ?? []).includes(path.relative(ROOT, p)),
    readBinary: readBinaryMock,
    loadExpectation: () => EXPECTATION,
    access: o.enabled === false ? SCHEMA_DIFF_DISABLED : { mode: "enabled-ro-schema-diff" },
    readDockerIdentity: docker,
    inspectDatabase: inspectDb,
    runAudit: audit,
    checkReadOnlyRole: role,
    checkAcl: acl,
    spawnCapture: spawn,
    interrupts,
    buildCommand: o.buildCommand,
    log: (text) => logs.push(text),
  };
  return { deps, docker, inspectDb, audit, role, acl, spawn, readBinary: readBinaryMock, logs, calls, interrupts };
}

function noSecrets(f: Fake, error?: unknown) {
  for (const secret of SECRETS) {
    if (error) expect((error as Error).message).not.toContain(secret);
    for (const line of f.logs) expect(line).not.toContain(secret);
  }
}

async function expectError(f: Fake, expected: SchemaDiffErrorCode): Promise<SchemaDiffError> {
  const caught = await runTestDbSchemaDiff(f.deps).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(SchemaDiffError);
  expect((caught as SchemaDiffError).code).toBe(expected);
  noSecrets(f, caught);
  return caught as SchemaDiffError;
}

const touchedNothingLive = (f: Fake) => {
  expect(f.docker).not.toHaveBeenCalled();
  expect(f.inspectDb).not.toHaveBeenCalled();
  expect(f.audit).not.toHaveBeenCalled();
  expect(f.role).not.toHaveBeenCalled();
  expect(f.acl).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
};

async function expectStopsBeforeLive(f: Fake, code: SchemaDiffErrorCode) {
  const error = await expectError(f, code);
  touchedNothingLive(f);
  return error;
}

const BEFORE = ["D1", "F1", "FP1", "A1", "R1", "D2"];
const AFTER = ["D3", "F2", "FP2", "R2"];
const withoutHash = (calls: string[]) => calls.filter((c) => c !== "hash");

describe("引数・ゲート（ゲートが無効なら、Docker・DB・Prisma CLI に到達しない）", () => {
  it("引数は「なし」（予行）か --live の1つだけ。それ以外は何にも触れる前に ARGUMENTS_INVALID", async () => {
    expect(parseTestDbSchemaDiffArgs([])).toBe("dry-run");
    expect(parseTestDbSchemaDiffArgs(["--live"])).toBe("live");
    for (const argv of [["--live", "--live"], ["--apply"], ["--script"], ["--live", "--output", "x"], ["--LIVE"], ["live"], ["--live=1"]]) {
      const f = fake({ argv });
      await expectStopsBeforeLive(f, "ARGUMENTS_INVALID");
      expect(f.readBinary).not.toHaveBeenCalled();
    }
  });

  it("固定のゲート SCHEMA_DIFF_DISABLED では、--live でも事前の検証の後で SCHEMA_DIFF_LIVE_DISABLED（Docker・DB・spawn は呼ばない）", async () => {
    const f = fake({ enabled: false });
    await expectStopsBeforeLive(f, "SCHEMA_DIFF_LIVE_DISABLED");
    expect(SCHEMA_DIFF_DISABLED).toEqual({ mode: "disabled" });
  });

  it("ゲートは環境変数・引数では解除できない（それらしい環境変数があっても、無効のゲートなら止まる）", async () => {
    const parentEnv = { PATH: "/usr/bin", SCHEMA_DIFF: "enabled", KATANA_SCHEMA_DIFF_LIVE: "1", ENABLE_SCHEMA_DIFF: "true" };
    await expectStopsBeforeLive(fake({ enabled: false, parentEnv }), "SCHEMA_DIFF_LIVE_DISABLED");
    await expectStopsBeforeLive(fake({ enabled: false, argv: ["--live", "--enable"] }), "ARGUMENTS_INVALID");
  });

  it("予行（引数なし）は、ゲートに関わらず Docker・DB・spawn に触れず、ファイルの検証と表示だけ（URL・パスワードは表示しない）", async () => {
    for (const enabled of [false, true]) {
      const f = fake({ argv: [], enabled });
      expect(await runTestDbSchemaDiff(f.deps)).toEqual({ mode: "dry-run" });
      touchedNothingLive(f);
      noSecrets(f);
      const text = f.logs.join("\n");
      expect(text).toContain("katana_test_ro");
      expect(text).toContain("migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code --config prisma.schemadiff.config.ts");
      expect(text).toContain(`${SCHEMA_DIFF_RO_URL_SHA256_ENV}`);
      expect(text).not.toContain(schemaDiffUrlSha256(RO_URL));
      expect(text).toContain("residual risk (accepted, not resolved)");
      expect(text).toContain(enabled ? "schema diff gate: enabled" : "SCHEMA_DIFF_LIVE_DISABLED");
      for (const line of SCHEMA_DIFF_SCOPE_NOTE) expect(text).toContain(line);
    }
  });
});

describe("誤接続の拒否（katana_test_ro 以外の認証情報・接続先は、Docker・DB・Prisma CLI に触れる前に止まる）", () => {
  it.each([
    ["katana_test_user の URL", RO_URL.replace("katana_test_ro", "katana_test_user"), "READ_ONLY_TARGET_REJECTED"],
    ["開発用DB", DEV_URL, "READ_ONLY_TARGET_REJECTED"],
    ["ほかのホスト", RO_URL.replace("127.0.0.1", "db.example.com"), "READ_ONLY_TARGET_REJECTED"],
    ["ポート 5433", RO_URL.replace(":5434", ":5433"), "READ_ONLY_TARGET_REJECTED"],
    ["DB 名 katana", RO_URL.replace(/\/katana_test$/, "/katana"), "READ_ONLY_TARGET_REJECTED"],
    ["?schema= 付き（CREATE SCHEMA の対象を変え得る）", `${RO_URL}?schema=other`, "READ_ONLY_TARGET_REJECTED"],
    ["?options= 付き", `${RO_URL}?options=-c%20default_transaction_read_only%3Doff`, "READ_ONLY_TARGET_REJECTED"],
    ["postgres（スーパーユーザー）", RO_URL.replace("katana_test_ro", "postgres"), "READ_ONLY_TARGET_REJECTED"],
  ] as const)(".env.test.readonly が %s なら止まる", async (_label, url, code) => {
    await expectStopsBeforeLive(fake({ roEnv: { KATANA_TEST_RO_DATABASE_URL: url, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD } }), code);
  });

  it.each([
    ["パスワードがアプリ用と同じ", { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, APP_PASSWORD), KATANA_TEST_DB_RO_PASSWORD: APP_PASSWORD }, "RO_PASSWORD_REUSED"],
    ["パスワードが短い", { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, "short_password"), KATANA_TEST_DB_RO_PASSWORD: "short_password" }, "RO_PASSWORD_TOO_SHORT"],
    ["URL とパスワードが違う", { ...RO_ENV, KATANA_TEST_DB_RO_PASSWORD: `${RO_PASSWORD}x` }, "RO_URL_PASSWORD_MISMATCH"],
    ["余分なキー（DATABASE_URL）", { ...RO_ENV, DATABASE_URL: APP_URL }, "RO_ENV_UNEXPECTED_KEY"],
  ] as const)(".env.test.readonly の認証情報が不正（%s）なら止まる", async (_label, roEnv, guardCode) => {
    const error = await expectStopsBeforeLive(fake({ roEnv }), "READ_ONLY_CREDENTIALS_REJECTED");
    expect(error.message).toContain(guardCode);
  });

  it("ファイルがない・.env.test が不正・開発用DBと同じなら止まる", async () => {
    await expectStopsBeforeLive(fake({ roEnv: null }), "READ_ONLY_ENV_MISSING");
    await expectStopsBeforeLive(fake({ testEnv: null }), "TEST_ENV_MISSING");
    await expectStopsBeforeLive(fake({ testEnv: { ...TEST_ENV, KATANA_TEST_DB_PASSWORD: "other" } }), "CREDENTIALS_REJECTED");
    await expectStopsBeforeLive(fake({ testEnv: { ...TEST_ENV, DATABASE_URL: DEV_URL } }), "TARGET_REJECTED");
    await expectStopsBeforeLive(fake({ devEnv: { DATABASE_URL: RO_URL } }), "TARGET_REJECTED");
  });

  it("親の PG*・DOTENV_*・NODE_OPTIONS・Node の起動オプション・DOCKER_HOST/DOCKER_CONTEXT は拒否する", async () => {
    await expectStopsBeforeLive(fake({ parentEnv: { PATH: "/usr/bin", PGPASSWORD: "x" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { PATH: "/usr/bin", DOTENV_CONFIG_PATH: ".env" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { NODE_OPTIONS: "--require x" } }), "NODE_OPTIONS_PRESENT");
    await expectStopsBeforeLive(fake({ execArgv: ["--import", "x"] }), "NODE_EXEC_ARGV_PRESENT");
    await expectStopsBeforeLive(fake({ parentEnv: { PATH: "/usr/bin", DOCKER_HOST: "tcp://x" } }), "DOCKER_TARGET_ENV_PRESENT");
  });

  it("必要なファイルがない・CLI か engine の SHA-256 が違う・darwin-arm64 以外なら止まる", async () => {
    for (const missing of ["prisma.schemadiff.config.ts", "node_modules/@prisma/engines/schema-engine-darwin-arm64", "node_modules/prisma/build/index.js", "prisma/schema.prisma"]) {
      await expectStopsBeforeLive(fake({ missingPaths: [missing] }), "REQUIRED_FILE_MISSING");
    }
    await expectStopsBeforeLive(fake({ readBinary: (p) => (p.endsWith("index.js") ? Buffer.from("x") : readBinary(p)) }), "BINARY_HASH_MISMATCH");
    await expectStopsBeforeLive(fake({ platform: "linux" }), "PLATFORM_NOT_SUPPORTED");
  });

  it("組み立ての関数が改ざんされても（migrate deploy・--script・prisma.config.ts）、Prisma CLI を起動しない", async () => {
    const entry = path.join(ROOT, "node_modules/prisma/build/index.js");
    for (const args of [
      [entry, "migrate", "deploy", "--config", path.join(ROOT, "prisma.schemadiff.config.ts")],
      [entry, "migrate", "diff", "--from-config-datasource", "--to-schema", path.join(ROOT, "prisma/schema.prisma"), "--script", "--config", path.join(ROOT, "prisma.schemadiff.config.ts")],
      [entry, "migrate", "diff", "--from-config-datasource", "--to-schema", path.join(ROOT, "prisma/schema.prisma"), "--exit-code", "--config", path.join(ROOT, "prisma.config.ts")],
    ]) {
      await expectStopsBeforeLive(fake({ buildCommand: ({ execPath }) => ({ command: execPath, args }) }), "COMMAND_REJECTED");
    }
  });
});

describe("実行の手順（D1 → F1 → FP1 → A1 → R1 → D2 → CLI → D3 → F2 → FP2 → R2）", () => {
  it("すべて通り CLI が 0 なら no-diff（終了コード 0）。順序・コマンド・環境変数（URL を含まない）を確かめる", async () => {
    const f = fake();
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(outcome).toMatchObject({ mode: "live", verdict: "no-diff", exitCode: 0, cli: { outcome: "no-diff" } });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
    // SHA-256 は事前の検証と、起動の直前の2回（CLI・engine の2ファイルずつ）
    expect(f.calls.filter((c) => c === "hash")).toHaveLength(4);
    expect(f.calls.lastIndexOf("hash")).toBeLessThan(f.calls.indexOf("CLI"));
    expect(f.calls.indexOf("D2")).toBeLessThan(f.calls.lastIndexOf("hash"));
    const [command, args, options] = f.spawn.mock.calls[0];
    expect(command).toBe(EXEC_PATH);
    expect(args).toEqual([
      `${ROOT}/node_modules/prisma/build/index.js`,
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      `${ROOT}/prisma/schema.prisma`,
      "--exit-code",
      "--config",
      `${ROOT}/prisma.schemadiff.config.ts`,
    ]);
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(options.cwd).toBe(ROOT);
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      CHECKPOINT_DISABLE: "1",
      CI: "1",
      RUST_LOG: "error",
      RUST_BACKTRACE: "0",
      KATANA_DB_TARGET: "test-readonly",
      [SCHEMA_DIFF_RO_URL_SHA256_ENV]: schemaDiffUrlSha256(RO_URL),
    });
    for (const s of SECRETS) expect(JSON.stringify([args, options])).not.toContain(s);
    // F・FP・A は katana_test_user、R は katana_test_ro で接続する（runner が URL を選ぶ。テストでは値を照合するだけ）
    expect(f.inspectDb.mock.calls.every(([input]) => input.databaseUrl === APP_URL)).toBe(true);
    expect(f.audit.mock.calls.every(([input]) => input.databaseUrl === APP_URL)).toBe(true);
    expect(f.acl.mock.calls.every(([input]) => input.databaseUrl === APP_URL)).toBe(true);
    expect(f.role.mock.calls.every(([input]) => input.databaseUrl === RO_URL)).toBe(true);
    const text = f.logs.join("\n");
    expect(text).toContain("verdict no-diff (exit code 0)");
    expect(text).toContain("no difference within what Prisma compares");
    expect(text).toContain("_prisma_migrations");
    expect(text).toContain("residual risk (accepted, not resolved)");
    noSecrets(f);
  });

  it("親の CI・RUST_LOG・PRISMA_*・DEBUG・DATABASE_URL は子プロセスに渡らない（固定の値で上書き・削除）", async () => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", CI: "false", RUST_LOG: "debug", PRISMA_SCHEMA_ENGINE_BINARY: "/evil", DEBUG: "*", DATABASE_URL: DEV_URL, FORCE_PANIC_SCHEMA_ENGINE: "1" } });
    await runTestDbSchemaDiff(f.deps);
    const env = f.spawn.mock.calls[0][2].env;
    expect(env.CI).toBe("1");
    expect(env.RUST_LOG).toBe("error");
    for (const key of ["PRISMA_SCHEMA_ENGINE_BINARY", "DEBUG", "DATABASE_URL", "FORCE_PANIC_SCHEMA_ENGINE"]) expect(env).not.toHaveProperty(key);
  });

  it.each([
    ["D1 の失敗", { dockers: [new Error("docker down")] }, "DOCKER_IDENTITY_FAILED", ["D1"]],
    ["F1 の失敗（本人確認）", { inspections: [new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", `bad ${APP_URL}`)] }, "STATE_CHECK_FAILED", ["D1", "F1"]],
    ["F1 と D1 のサーバーが合わない", { inspections: [{ state: STATE_C, server: { ...SERVER, serverPort: 5433 } }] }, "SERVER_IDENTITY_MISMATCH", ["D1", "F1"]],
    ["状態 A", { inspections: [{ state: { state: "A" } as TestDatabaseState }] }, "DATABASE_STATE_NOT_C", ["D1", "F1"]],
    ["migration の一覧が違う", { inspections: [{ state: { ...STATE_C, migrations: ["m1"] } as TestDatabaseState }] }, "MIGRATION_LIST_MISMATCH", ["D1", "F1"]],
    ["FP1 の監査が failed", { auditVerdict: "failed" as const }, "CATALOG_CHECK_FAILED", ["D1", "F1", "FP1"]],
    ["FP1 の接続の失敗", { fingerprints: [new Error(`x ${APP_URL}`)] }, "CATALOG_CHECK_FAILED", ["D1", "F1", "FP1"]],
    ["FP1 でロールがない", { fingerprints: [createdFp((s) => (s.roles = s.roles.filter(([k]) => !k.includes("katana_test_ro"))))] }, "ROLE_NOT_CREATED", ["D1", "F1", "FP1"]],
    ["FP1 でテーブルの ACL が期待と違う（INSERT 付き）", { fingerprints: [createdFp((s) => (s.relations = s.relations.map(([k, v]) => [k, v.replace("katana_test_ro=r/", "katana_test_ro=ar/")] as const)))] }, "CATALOG_STATE_MISMATCH", ["D1", "F1", "FP1"]],
    ["A1 の接続の失敗", { acl: new Error("lost") }, "ACL_CHECK_FAILED", ["D1", "F1", "FP1", "A1"]],
    ["A1 の ACL が期待と違う", { acl: { ...createdAcl(), schemas: [] } }, "ACL_MISMATCH", ["D1", "F1", "FP1", "A1"]],
    ["R1 の接続・認証の失敗", { observations: [new Error(`auth ${RO_URL}`)] }, "READ_ONLY_ROLE_CHECK_FAILED", ["D1", "F1", "FP1", "A1", "R1"]],
    ["R1 で書き込みの権限がある", { observations: [observation({ write: true })] }, "READ_ONLY_NOT_ENFORCED", ["D1", "F1", "FP1", "A1", "R1"]],
    ["D2 が D1 と違う", { dockers: [DOCKER, { ...DOCKER, containerId: "d".repeat(64) }] }, "DOCKER_IDENTITY_MISMATCH", BEFORE],
  ] as const)("CLI の前の検査の失敗（%s）では、Prisma CLI を起動しない", async (_label, o, code, steps) => {
    const f = fake(o as Parameters<typeof fake>[0]);
    const error = await expectError(f, code);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(withoutHash(f.calls)).toEqual([...steps]);
    expect(error.message).toContain("The Prisma CLI was not started.");
  });

  it("起動の直前の SHA-256 の再照合で違えば（D2 の後の差し替え）、Prisma CLI を起動しない", async () => {
    let reads = 0;
    const f = fake({
      readBinary: (p) => {
        reads += 1;
        return reads > 2 && p.endsWith("schema-engine-darwin-arm64") ? Buffer.from("swapped") : readBinary(p);
      },
    });
    await expectError(f, "BINARY_HASH_MISMATCH");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(withoutHash(f.calls)).toEqual(BEFORE);
  });
});

describe("CLI の結果と事後の検査（成否にかかわらず D3・F2・FP2・R2 をすべて試す）", () => {
  it.each([
    ["差分なし（0）", exit(0), "no-diff", 0, "no-diff"],
    ["差分あり（2）", exit(2, "[*] Changed the `Shop` table"), "diff", 2, "diff"],
    ["CLI のエラー（1）", exit(1, "", "Error: P1001"), "cli-failed", 1, "cli-error"],
    ["想定外のコード（101：engine の panic）", exit(101), "cli-failed", 1, "unexpected-exit"],
    ["シグナル", exit(null, "", "", "SIGSEGV"), "cli-failed", 1, "signal"],
    ["タイムアウト（プロセスグループを止めた後）", { kind: "timeout", stdout: "", stderr: "", processGroup: "stopped" } as const, "cli-failed", 1, "timeout"],
    ["起動の失敗", { kind: "spawn-error", errorCode: "ENOENT" } as const, "cli-failed", 1, "spawn-failed"],
  ] as const)("%s：事後の検査がすべて通れば、判定は表のとおり", async (_label, result, verdict, exitCode, cliOutcome) => {
    const f = fake({ result });
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(outcome).toMatchObject({ mode: "live", verdict, exitCode, cli: { outcome: cliOutcome } });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
    if (outcome.mode === "live") expect(outcome.postChecks.map((c) => [c.label, c.passed])).toEqual(AFTER.map((l) => [l, true]));
    noSecrets(f);
  });

  it("spawn が例外を投げても、成功とは扱わず、事後の検査をすべて行う（起動したか分からないので、プロセスグループは not-confirmed・cleanup-failed）", async () => {
    const f = fake({ result: Object.assign(new Error(`spawn ${RO_URL}`), { code: "EACCES" }) });
    expect(await runTestDbSchemaDiff(f.deps)).toMatchObject({
      verdict: "cleanup-failed",
      exitCode: 1,
      processGroup: "not-confirmed",
      cli: { outcome: "spawn-failed", errorCode: "EACCES" },
    });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
    noSecrets(f);
  });

  it.each([
    ["D3 の失敗", { dockers: [DOCKER, DOCKER, new Error("x")] }, "D3"],
    ["D3 がコンテナの変化を検出", { dockers: [DOCKER, DOCKER, { ...DOCKER, restartCount: 1 }] }, "D3"],
    ["F2 の失敗", { inspections: [{ state: STATE_C }, new Error(`lost ${APP_URL}`)] }, "F2"],
    ["F2 でサーバーが変わった", { inspections: [{ state: STATE_C }, { state: STATE_C, server: { ...SERVER, postmasterStartTime: "2026-11-06T23:00:00.000000Z" } }] }, "F2"],
    ["F2 で状態 C でない", { inspections: [{ state: STATE_C }, { state: { state: "B", reasons: ["x"] } as TestDatabaseState }] }, "F2"],
    ["FP2 の失敗", { fingerprints: [createdFp(), new Error("lost")] }, "FP2"],
    ["FP2 が FP1 から変化（スキーマの作成）", { fingerprints: [createdFp(), createdFp((s) => s.schemas.push(entry("schemas", { name: "other", owner: "katana_test_ro", acl: null })))] }, "FP2"],
    ["R2 の失敗", { observations: [observation(), new Error(`auth ${RO_URL}`)] }, "R2"],
    ["R2 で書き込みの権限", { observations: [observation(), observation({ write: true })] }, "R2"],
  ] as const)("事後の検査の失敗（%s）：CLI が 0 でも成功にせず、残りの検査もすべて試す（DB 不変を保証しない）", async (_label, o, failed) => {
    for (const result of [exit(0), exit(2, "[+] x"), exit(1)]) {
      const f = fake({ ...(o as Parameters<typeof fake>[0]), result });
      const outcome = await runTestDbSchemaDiff(f.deps);
      expect(outcome).toMatchObject({ mode: "live", verdict: "post-check-failed", exitCode: 1 });
      expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
      if (outcome.mode === "live") {
        expect(outcome.postChecks.map((c) => c.label)).toEqual(AFTER);
        expect(outcome.postChecks.filter((c) => !c.passed).map((c) => c.label)).toEqual([failed]);
      }
      const text = f.logs.join("\n");
      expect(text).toContain("verdict post-check-failed");
      expect(text).toContain("it is not guaranteed that the database is unchanged");
      noSecrets(f);
    }
  });

  it("事後の検査が複数失敗しても、すべて記録する", async () => {
    const f = fake({ dockers: [DOCKER, DOCKER, new Error("x")], inspections: [{ state: STATE_C }, new Error("y")], fingerprints: [createdFp(), new Error("z")], observations: [observation(), new Error("w")] });
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(outcome).toMatchObject({ verdict: "post-check-failed", exitCode: 1 });
    if (outcome.mode === "live") expect(outcome.postChecks.map((c) => [c.label, c.passed])).toEqual(AFTER.map((l) => [l, false]));
  });

  it("CLI の出力（差分の要約・エラー）は伏せてから表示する（ro・アプリ用の URL・パスワード、JSON の中の URL）", async () => {
    const noisy = `Error: ${JSON.stringify({ message: `P1000 for ${RO_URL}`, url: RO_URL })} ${RO_PASSWORD} ${APP_PASSWORD} ${ADMIN_PASSWORD} ${DEV_URL}`;
    for (const result of [
      exit(1, noisy, noisy),
      exit(2, noisy),
      { kind: "timeout", stdout: noisy, stderr: noisy, processGroup: "stopped" } as const,
      { kind: "interrupted", signal: "SIGINT", stdout: noisy, stderr: noisy, processGroup: "stopped" } as const,
      exit(7, noisy),
    ]) {
      const f = fake({ result });
      const outcome = await runTestDbSchemaDiff(f.deps);
      expect(JSON.stringify(outcome)).not.toMatch(new RegExp([RO_PASSWORD, APP_PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD].join("|")));
      noSecrets(f);
      expect(f.logs.join("\n")).toContain("(hidden)");
    }
  });
});

describe("最終判定の表（decideSchemaDiffVerdict）", () => {
  const passed = (labels: string[] = AFTER): PostCheckResult[] => labels.map((label) => ({ label: label as PostCheckResult["label"], passed: true, detail: "passed" }));
  const clean = { processGroup: "stopped", interruptedBy: undefined } as const;

  it("事後の検査がすべて通り、プロセスグループの停止を確かめ、中断がないときだけ、CLI の 0・2 を no-diff・diff にする", () => {
    expect(decideSchemaDiffVerdict({ outcome: "no-diff" }, passed(), clean)).toEqual({ verdict: "no-diff", exitCode: 0 });
    expect(decideSchemaDiffVerdict({ outcome: "diff", summary: "x" }, passed(), clean)).toEqual({ verdict: "diff", exitCode: 2 });
    expect(decideSchemaDiffVerdict({ outcome: "cli-error", output: "" }, passed(), clean)).toEqual({ verdict: "cli-failed", exitCode: 1 });
    expect(decideSchemaDiffVerdict({ outcome: "spawn-failed", errorCode: "ENOENT" }, passed(), { processGroup: "not-started", interruptedBy: undefined })).toEqual({
      verdict: "cli-failed",
      exitCode: 1,
    });
  });

  it("事後の検査が1つでも失敗・欠けていれば、CLI の結果・中断・後始末に関わらず post-check-failed", () => {
    const oneFailed = passed().map((c, i) => (i === 2 ? { ...c, passed: false } : c));
    for (const cli of [{ outcome: "no-diff" } as const, { outcome: "diff", summary: "x" } as const, { outcome: "timeout", output: "" } as const]) {
      for (const run of [clean, { processGroup: "not-confirmed", interruptedBy: "SIGINT" } as const]) {
        expect(decideSchemaDiffVerdict(cli, oneFailed, run)).toEqual({ verdict: "post-check-failed", exitCode: 1 });
        expect(decideSchemaDiffVerdict(cli, passed(["D3", "F2", "FP2"]), run)).toEqual({ verdict: "post-check-failed", exitCode: 1 });
        expect(decideSchemaDiffVerdict(cli, [], run)).toEqual({ verdict: "post-check-failed", exitCode: 1 });
      }
    }
  });

  it("プロセスグループの停止を確かめられなければ、CLI が 0・2 でも cleanup-failed（起動したのに not-started と報告された場合も）", () => {
    for (const cli of [{ outcome: "no-diff" } as const, { outcome: "diff", summary: "x" } as const]) {
      expect(decideSchemaDiffVerdict(cli, passed(), { processGroup: "not-confirmed", interruptedBy: undefined })).toEqual({ verdict: "cleanup-failed", exitCode: 1 });
      expect(decideSchemaDiffVerdict(cli, passed(), { processGroup: "not-started", interruptedBy: undefined })).toEqual({ verdict: "cleanup-failed", exitCode: 1 });
    }
  });

  it("中断を受けていれば、CLI が 0・2 でも interrupted（正常終了・no-diff にしない）", () => {
    for (const cli of [{ outcome: "no-diff" } as const, { outcome: "diff", summary: "x" } as const, { outcome: "interrupted", signal: "SIGTERM", output: "" } as const]) {
      expect(decideSchemaDiffVerdict(cli, passed(), { processGroup: "stopped", interruptedBy: "SIGINT" })).toEqual({ verdict: "interrupted", exitCode: 1 });
    }
    expect(decideSchemaDiffVerdict({ outcome: "interrupted", signal: "SIGTERM", output: "" }, passed(), clean)).toEqual({ verdict: "interrupted", exitCode: 1 });
  });
});

describe("中断（親のプロセスへの SIGINT・SIGTERM）", () => {
  it.each(["D1", "F1", "FP1", "A1", "R1", "D2"])("CLI の起動の前（%s の実行中）に中断を受けたら、その段階の後で INTERRUPTED で止め、Prisma CLI を起動しない", async (at) => {
    const f = fake({ interruptAt: at });
    const error = await expectError(f, "INTERRUPTED");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(withoutHash(f.calls)).toEqual(BEFORE.slice(0, BEFORE.indexOf(at) + 1));
    expect(error.message).toContain("SIGINT");
    expect(error.message).toContain("The Prisma CLI was not started.");
  });

  it.each(["D1", "F1", "FP1", "A1", "R1", "D2"])("中断でその段階（%s）が失敗しても、検査の失敗ではなく INTERRUPTED として止める", async (at) => {
    const f = fake({ interruptAt: at, interruptSignal: "SIGTERM", interruptFails: true });
    const error = await expectError(f, "INTERRUPTED");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(error.message).toContain("SIGTERM");
  });

  it("CLI の実行中の中断：spawnCapture に中断を渡し、グループを止めた後で D3・F2・FP2・R2 をすべて試し、判定は interrupted（終了コード 1）", async () => {
    const f = fake({ interruptAt: "CLI", result: { kind: "interrupted", signal: "SIGINT", stdout: "", stderr: "", processGroup: "stopped" } });
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(f.spawn.mock.calls[0][3]).toBe(f.interrupts);
    expect(outcome).toMatchObject({ mode: "live", verdict: "interrupted", exitCode: 1, interruptedBy: "SIGINT", processGroup: "stopped", cli: { outcome: "interrupted" } });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
    const text = f.logs.join("\n");
    expect(text).toContain("verdict interrupted");
    expect(text).toContain("interrupted by SIGINT");
    expect(text).toContain("it is not guaranteed that the database is unchanged");
    noSecrets(f);
  });

  it.each([
    ["CLI が 0 で終わった直後", "CLI", exit(0)],
    ["事後の検査 F2 の実行中", "F2", exit(0)],
    ["事後の検査 R2 の実行中（差分あり）", "R2", exit(2, "[+] x")],
  ] as const)("%s に中断を受けても、no-diff・diff にせず interrupted（残りの事後の検査も試す）", async (_label, at, result) => {
    const f = fake({ interruptAt: at, result });
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(outcome).toMatchObject({ verdict: "interrupted", exitCode: 1, interruptedBy: "SIGINT" });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
  });

  it("中断で事後の検査が失敗したら post-check-failed（DB 不変を保証しない）", async () => {
    const f = fake({ interruptAt: "D3", interruptFails: true, result: { kind: "interrupted", signal: "SIGINT", stdout: "", stderr: "", processGroup: "stopped" } });
    const outcome = await runTestDbSchemaDiff(f.deps);
    expect(outcome).toMatchObject({ verdict: "post-check-failed", exitCode: 1, interruptedBy: "SIGINT" });
    expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
    expect(f.logs.join("\n")).toContain("it is not guaranteed that the database is unchanged");
    noSecrets(f);
  });

  it("CLI のプロセスグループの停止を確かめられなければ、CLI が 0 でも cleanup-failed。残ったプロセスの確認を促す", async () => {
    for (const result of [
      { ...exit(0), processGroup: "not-confirmed" } as const,
      { kind: "interrupted", signal: "SIGTERM", stdout: "", stderr: "", processGroup: "not-confirmed" } as const,
    ]) {
      const f = fake({ result });
      const outcome = await runTestDbSchemaDiff(f.deps);
      expect(outcome).toMatchObject({ verdict: "cleanup-failed", exitCode: 1, processGroup: "not-confirmed" });
      expect(withoutHash(f.calls)).toEqual([...BEFORE, "CLI", ...AFTER]);
      const text = f.logs.join("\n");
      expect(text).toContain("could not be confirmed as stopped");
      expect(text).toContain("it is not guaranteed that the database is unchanged");
    }
  });

  it("予行・ゲートが無効のときは、中断の有無で動作が変わらない（中断を確かめる前に終わる。終了コードはスクリプトが 1 にする）", async () => {
    const dry = fake({ argv: [] });
    expect(await runTestDbSchemaDiff(dry.deps)).toEqual({ mode: "dry-run" });
    await expectStopsBeforeLive(fake({ enabled: false }), "SCHEMA_DIFF_LIVE_DISABLED");
  });
});

describe("静的な確認", () => {
  const code = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

  it("migration の件数は checksum と同じ", () => {
    expect(EXPECTED_SCHEMA_DIFF_MIGRATION_COUNT).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it("スクリプトは、最初に SIGINT・SIGTERM の受け付けを登録し、中断を受けていたら終了コード 1 にする。上限のタイマーは終了を妨げない（unref）", () => {
    const script = code("scripts/testdb-schema-diff.mts");
    const controller = script.indexOf("createSchemaDiffInterruptController({");
    expect(controller).toBeGreaterThan(-1);
    expect(controller).toBeLessThan(script.indexOf("runTestDbSchemaDiff({"));
    expect(script).toContain("process.on(signal, handler)");
    expect(script).toContain("setTimeout(callback, ms).unref()");
    expect(script).toContain("deadlineMs: SCHEMA_DIFF_INTERRUPT_DEADLINE_MS");
    expect(script).toContain("process.exitCode = interrupts.received() !== undefined ? 1 :");
    expect(script).toContain("process.kill(-pgid, 0)");
    expect(script).toMatch(/code !== "ESRCH"/);
    expect(script).toMatch(/^\s+interrupts,$/m);
  });

  it("runner は、ゲートの判定の後でだけ Docker・DB・spawn を呼ぶ（ソースの順序）", () => {
    const runner = code("lib/testing/testDbSchemaDiffRunner.ts");
    const gate = runner.indexOf('throw new SchemaDiffError("SCHEMA_DIFF_LIVE_DISABLED"');
    expect(gate).toBeGreaterThan(-1);
    for (const call of ["deps.readDockerIdentity(", "deps.inspectDatabase(", "deps.runAudit(", "deps.checkAcl(", "deps.checkReadOnlyRole(", "deps.spawnCapture("]) {
      const first = runner.indexOf(call);
      expect(first, call).toBeGreaterThan(gate);
    }
  });
});
