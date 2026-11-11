import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck";
import { SCHEMA_DIFF_DISABLED } from "./schemaDiff";
import {
  CATALOG_FINGERPRINT_SECTIONS,
  CatalogAuditError,
  type CatalogAuditExpectation,
  type CatalogAuditReport,
  type CatalogDefinitionAuditResult,
  type CatalogFingerprint,
  loadCatalogAuditExpectation,
} from "./testDbCatalogAudit";
import {
  CATALOG_AUDIT_DATABASE_DISABLED,
  EXPECTED_CATALOG_MIGRATION_COUNT,
  parseTestDbCatalogArgs,
  runTestDbCatalogAudit,
  type TestDbCatalogDeps,
  TestDbCatalogError,
  type TestDbCatalogErrorCode,
} from "./testDbCatalogRunner";
import { CHECKSUM_DATABASE_DISABLED, EXPECTED_MIGRATION_COUNT } from "./testDbChecksums";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { type InspectDatabase, LIVE_DATABASE_DISABLED, type ReadDockerIdentity } from "./testDbMigrate";
import type { TestDatabasePrivileges, TestDatabaseState } from "./testDbState";

// DB にも Docker にも接続せず、Prisma CLI も起動しない。Docker・DB の判定・カタログの監査は、すべて偽の関数で置き換える
// （期待値は、リポジトリの prisma/schema.prisma と prisma/migrations を読むだけで作る）
const ROOT = "/fake/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "catalog-runner-dummy-pass";
const ADMIN_PASSWORD = "catalog-runner-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "catalog-runner-dev-dummy";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const FINGERPRINT_HASH = "9".repeat(64);
const SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, FINGERPRINT_HASH, "postgresql://", "postgres://"];
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };

const EXPECTATION = loadCatalogAuditExpectation(REPO_ROOT);
const MIGRATIONS = [...EXPECTATION.inventory.migrations];

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
const STATE_C: TestDatabaseState = { state: "C", tables: [...EXPECTATION.inventory.tables], migrations: MIGRATIONS, schemaDiff: "not-verified" };

function fingerprint(sections = Object.keys(CATALOG_FINGERPRINT_SECTIONS)): CatalogFingerprint {
  return { meaning: "observed-catalog-definition", sha256: FINGERPRINT_HASH, sections: Object.fromEntries(sections.map((s) => [s, [["[\"k\"]", "[\"secret-value\"]"]]])) };
}
const auditResult = (report: CatalogAuditReport = { verdict: "passed", findings: [] }, fp = fingerprint()): CatalogDefinitionAuditResult => ({ report, fingerprint: fp });

type Fake = {
  deps: TestDbCatalogDeps;
  docker: Mock<ReadDockerIdentity>;
  inspectDb: Mock<InspectDatabase>;
  audit: Mock<TestDbCatalogDeps["runAudit"]>;
  readEnv: Mock<TestDbCatalogDeps["readEnvFile"]>;
  logs: string[];
  calls: string[];
};

function fake(
  o: {
    argv?: string[];
    enabled?: boolean;
    testEnv?: Record<string, string | undefined> | null;
    parentEnv?: Record<string, string | undefined>;
    execArgv?: string[];
    expectation?: () => CatalogAuditExpectation;
    pathExists?: (p: string) => boolean;
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  let dockerCount = 0;
  let inspectCount = 0;
  const docker = vi.fn<ReadDockerIdentity>(async () => {
    dockerCount += 1;
    calls.push(`D${dockerCount}`);
    return { ...DOCKER };
  });
  const inspectDb = vi.fn<InspectDatabase>(async () => {
    inspectCount += 1;
    calls.push(`F${inspectCount}`);
    return { state: STATE_C, privileges: PRIVILEGES, server: { ...SERVER } };
  });
  const audit = vi.fn<TestDbCatalogDeps["runAudit"]>(async () => {
    calls.push("audit");
    return auditResult();
  });
  const readEnv = vi.fn<TestDbCatalogDeps["readEnvFile"]>((file) => {
    if (file.endsWith(".env.test")) return o.testEnv === null ? undefined : (o.testEnv ?? GOOD_TEST_ENV);
    if (file.endsWith(".env")) return { DATABASE_URL: DEV_URL };
    return undefined;
  });
  const deps: TestDbCatalogDeps = {
    root: ROOT,
    argv: o.argv ?? ["--verify"],
    execArgv: o.execArgv ?? [],
    parentEnv: o.parentEnv ?? { PATH: "/usr/bin" },
    readEnvFile: readEnv,
    pathExists: o.pathExists ?? (() => true),
    loadExpectation: o.expectation ?? (() => EXPECTATION),
    catalogDatabase: o.enabled === false ? CATALOG_AUDIT_DATABASE_DISABLED : { mode: "enabled-read-only" },
    readDockerIdentity: docker,
    inspectDatabase: inspectDb,
    runAudit: audit,
    log: (text) => logs.push(text),
  };
  return { deps, docker, inspectDb, audit, readEnv, logs, calls };
}

async function expectError(f: Fake, code: TestDbCatalogErrorCode): Promise<TestDbCatalogError> {
  try {
    await runTestDbCatalogAudit(f.deps);
  } catch (error) {
    expect(error).toBeInstanceOf(TestDbCatalogError);
    expect((error as TestDbCatalogError).code).toBe(code);
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    for (const line of f.logs) for (const secret of SECRETS) expect(line).not.toContain(secret);
    return error as TestDbCatalogError;
  }
  throw new Error(`expected ${code}`);
}

const touchedNothing = (f: Fake) => {
  expect(f.docker).not.toHaveBeenCalled();
  expect(f.inspectDb).not.toHaveBeenCalled();
  expect(f.audit).not.toHaveBeenCalled();
};

describe("引数・予行・ゲート（Docker・DB に触れない）", () => {
  it("1. 予行：事前の検証と期待値の構築だけ。Docker・DB に触れず、結果は dry-run", async () => {
    const f = fake({ argv: [], enabled: false });
    await expect(runTestDbCatalogAudit(f.deps)).resolves.toEqual({ mode: "dry-run" });
    touchedNothing(f);
    expect(f.logs.join("\n")).toContain("dry run (--verify was not given)");
    expect(f.logs.join("\n")).toContain("15 tables, 5 enums");
    expect(f.logs.join("\n")).toContain("disabled in this build");
    for (const secret of SECRETS) expect(f.logs.join("\n")).not.toContain(secret);
  });

  it("2. ゲートが無効なら、--verify でも Docker・DB の前に CATALOG_AUDIT_LIVE_DISABLED で止まる", async () => {
    const f = fake({ enabled: false });
    await expectError(f, "CATALOG_AUDIT_LIVE_DISABLED");
    touchedNothing(f);
  });

  it("3. 不正な引数（--apply・未知・併用・重複）は、何にも触れる前に ARGUMENTS_INVALID", async () => {
    for (const argv of [["--apply"], ["--verify", "--apply"], ["--verify", "--verify"], ["--check"], ["verify"], ["--verify=1"]]) {
      expect(() => parseTestDbCatalogArgs(argv)).toThrow(TestDbCatalogError);
      const f = fake({ argv });
      await expectError(f, "ARGUMENTS_INVALID");
      expect(f.readEnv).not.toHaveBeenCalled();
      touchedNothing(f);
    }
  });

  it("4. 開発用DB・別の接続先・親の PG*・NODE_OPTIONS・Node の起動オプション・パスワードの不備は、接続の前に拒否する", async () => {
    const cases: [Parameters<typeof fake>[0], TestDbCatalogErrorCode][] = [
      [{ testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: DEV_URL } }, "TARGET_REJECTED"],
      [{ testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: `postgresql://katana_test_user:${PASSWORD}@db.example.com:5434/katana_test` } }, "TARGET_REJECTED"],
      [{ parentEnv: { PGHOST: "elsewhere" } }, "UNSAFE_PARENT_ENV"],
      [{ parentEnv: { NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
      [{ execArgv: ["--inspect"] }, "NODE_EXEC_ARGV_PRESENT"],
      [{ testEnv: { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "other" } }, "CREDENTIALS_REJECTED"],
      [{ testEnv: null }, "TEST_ENV_MISSING"],
      [{ pathExists: () => false }, "REQUIRED_FILE_MISSING"],
    ];
    for (const [options, code] of cases) {
      const f = fake(options);
      await expectError(f, code);
      touchedNothing(f);
    }
  });

  it("期待値を作れない・確定できない・migration の件数が違うときは、予行でも Docker・DB の前に止める（unverified を成功にしない）", async () => {
    const cases: [() => CatalogAuditExpectation, TestDbCatalogErrorCode][] = [
      [
        () => {
          throw new CatalogAuditError("EXPECTATION_INVALID", "bad");
        },
        "EXPECTATION_INVALID",
      ],
      [() => ({ ...EXPECTATION, enums: { status: "unsupported", reasons: ["m: unsupported TYPE statement"] } }), "EXPECTATION_UNSUPPORTED"],
      [() => ({ ...EXPECTATION, dbSpecific: { status: "unsupported", reasons: ["m: check constraint"] } }), "EXPECTATION_UNSUPPORTED"],
      [() => ({ ...EXPECTATION, inventory: { ...EXPECTATION.inventory, migrations: MIGRATIONS.slice(1) } }), "MIGRATION_COUNT_MISMATCH"],
    ];
    for (const [expectation, code] of cases) {
      for (const argv of [[], ["--verify"]]) {
        const f = fake({ argv, expectation });
        await expectError(f, code);
        touchedNothing(f);
      }
    }
  });
});

describe("実DBでの監査の手順（ゲートを有効にした偽の依存だけ）", () => {
  it("9. 正常：D1 → F1 → D2 → 監査 → F2 → D3 の順。監査には D1・F1 の識別情報と期待値を渡し、結果（fingerprint を含む）を返す", async () => {
    const f = fake();
    const outcome = await runTestDbCatalogAudit(f.deps);
    expect(f.calls).toEqual(["D1", "F1", "D2", "audit", "F2", "D3"]);
    expect(f.audit).toHaveBeenCalledWith({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, expectation: EXPECTATION, expectedServer: { docker: DOCKER, server: SERVER } });
    expect(f.inspectDb).toHaveBeenCalledWith({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL });
    expect(outcome.mode).toBe("verify");
    if (outcome.mode === "verify") {
      expect(outcome.result.report.verdict).toBe("passed");
      expect(outcome.result.fingerprint.meaning).toBe("observed-catalog-definition");
      expect(Object.keys(outcome.result.fingerprint.sections)).toHaveLength(18);
    }
    const log = f.logs.join("\n");
    expect(log).toContain("the catalog definition audit passed");
    expect(log).toContain("18 sections captured (hash and values not shown)");
    expect(log).toContain("A single capture is not a before/after comparison");
    expect(log).toContain("does not verify the read-only role");
    for (const secret of [...SECRETS, "secret-value"]) expect(log).not.toContain(secret);
  });

  it("5. D1 の失敗：DOCKER_IDENTITY_FAILED で、DB に接続しない", async () => {
    const f = fake();
    f.docker.mockRejectedValueOnce(Object.assign(new Error(`docker failed ${TEST_URL}`), { code: "DOCKER_CONTEXT_MISMATCH" }));
    expect((await expectError(f, "DOCKER_IDENTITY_FAILED")).message).toContain("D1");
    expect(f.inspectDb).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });

  it("6. F1 の本人確認の失敗：STATE_CHECK_FAILED で、監査しない", async () => {
    for (const code of ["MARKER_MISMATCH", "NOT_READ_ONLY", "CURRENT_USER_MISMATCH"] as const) {
      const f = fake();
      f.inspectDb.mockRejectedValueOnce(new IntegrationDatabaseCheckError(code, "identity failed"));
      expect((await expectError(f, "STATE_CHECK_FAILED")).message).toContain(code);
      expect(f.audit).not.toHaveBeenCalled();
      expect(f.calls).toEqual(["D1"]);
    }
  });

  it("7. F1 が状態 A・B・migration の不一致・サーバーの不一致なら、監査しない", async () => {
    const cases: [TestDatabaseState | null, TestDatabaseServerIdentity | null, TestDbCatalogErrorCode][] = [
      [{ state: "A" }, null, "DATABASE_STATE_NOT_C"],
      [{ state: "B", reasons: ["unexpected relations: public.v (v)"] }, null, "DATABASE_STATE_NOT_C"],
      [{ ...STATE_C, migrations: MIGRATIONS.slice(1) }, null, "MIGRATION_LIST_MISMATCH"],
      [{ ...STATE_C, migrations: [...MIGRATIONS.slice(1), "20990101000000_other"] }, null, "MIGRATION_LIST_MISMATCH"],
      [null, { ...SERVER, serverPort: 5433 }, "SERVER_IDENTITY_MISMATCH"],
      [null, { ...SERVER, postmasterStartTime: "2026-11-06T20:00:00.000000Z" }, "SERVER_IDENTITY_MISMATCH"],
    ];
    for (const [state, server, code] of cases) {
      const f = fake();
      f.inspectDb.mockResolvedValueOnce({ state: state ?? STATE_C, privileges: PRIVILEGES, server: server ?? SERVER });
      await expectError(f, code);
      expect(f.audit).not.toHaveBeenCalled();
    }
  });

  it("8. D2 の識別の不一致：DOCKER_IDENTITY_MISMATCH で、監査しない", async () => {
    const f = fake();
    f.docker.mockResolvedValueOnce({ ...DOCKER }).mockResolvedValueOnce({ ...DOCKER, startedAt: "2026-11-07T00:00:00.000000000Z" });
    await expectError(f, "DOCKER_IDENTITY_MISMATCH");
    expect(f.audit).not.toHaveBeenCalled();
  });

  it("10・12. 監査の結果が failed（enum の不一致・DB 固有の定義など）なら CATALOG_AUDIT_FAILED（F2・D3 は行う）", async () => {
    for (const findings of [
      [{ category: "ENUM_MISMATCH" as const, items: ["enum UserRole: order differs"] }],
      [{ category: "UNEXPECTED_OBJECT" as const, items: ["Product.Product_price_check (check constraint)"] }],
      [{ category: "MISSING_OBJECT" as const, items: ["missing tables: Product"] }],
    ]) {
      const f = fake();
      f.audit.mockResolvedValueOnce(auditResult({ verdict: "failed", findings }));
      const error = await expectError(f, "CATALOG_AUDIT_FAILED");
      expect(error.message).toContain(findings[0].category);
      expect(f.calls).toEqual(["D1", "F1", "D2", "F2", "D3"]);
    }
  });

  it("11. 監査の結果が unverified なら CATALOG_AUDIT_UNVERIFIED（成功にしない）", async () => {
    const f = fake();
    f.audit.mockResolvedValueOnce(auditResult({ verdict: "unverified", findings: [{ category: "EXPECTATION_UNSUPPORTED", items: ["enum expectation: m"] }] }));
    await expectError(f, "CATALOG_AUDIT_UNVERIFIED");
  });

  it("13・15. 監査の SQL の失敗・不正な結果・ROLLBACK や接続の解放の失敗は CATALOG_AUDIT_CHECK_FAILED（F2・D3 は行う）", async () => {
    for (const code of ["CATALOG_QUERY_FAILED", "INVALID_CATALOG_RESULT", "TRANSACTION_CLOSE_FAILED", "CONNECT_FAILED", "IDENTITY_CHECK_FAILED"] as const) {
      const f = fake();
      f.audit.mockRejectedValueOnce(new CatalogAuditError(code, "detail"));
      expect((await expectError(f, "CATALOG_AUDIT_CHECK_FAILED")).message).toContain(code);
      expect(f.calls).toEqual(["D1", "F1", "D2", "F2", "D3"]);
    }
    const f = fake();
    // runCatalogDefinitionAudit は CatalogAuditError に包んで投げる。包まれていない例外は、コードの形でなければ unknown（メッセージは表示しない）
    f.audit.mockRejectedValueOnce(Object.assign(new Error(`driver said ${TEST_URL}`), { code: "42501" }));
    const raw = await expectError(f, "CATALOG_AUDIT_CHECK_FAILED");
    expect(raw.message).toContain("(unknown)");
    expect(raw.message).not.toContain("driver said");
  });

  it("14. 監査の接続のサーバーの識別の不一致は CATALOG_AUDIT_CONNECTION_IDENTITY_MISMATCH", async () => {
    const f = fake();
    f.audit.mockRejectedValueOnce(new CatalogAuditError("SERVER_IDENTITY_MISMATCH", "this connection does not reach the verified server (server address does not match the container network address)"));
    expect((await expectError(f, "CATALOG_AUDIT_CONNECTION_IDENTITY_MISMATCH")).message).toContain("server address does not match");
  });

  it("fingerprint が18区分そろっていなければ成功にしない", async () => {
    const f = fake();
    f.audit.mockResolvedValueOnce(auditResult(undefined, fingerprint(["columns"])));
    await expectError(f, "CATALOG_AUDIT_CHECK_FAILED");
  });

  it("16・18. F2 の失敗・状態 C 以外・サーバーの変化は、監査が passed でも失敗（POST_CHECK_FAILED・POST_STATE_MISMATCH・POST_IDENTITY_MISMATCH）", async () => {
    const failing = fake();
    failing.inspectDb.mockResolvedValueOnce({ state: STATE_C, privileges: PRIVILEGES, server: SERVER }).mockRejectedValueOnce(new IntegrationDatabaseCheckError("QUERY_FAILED", "x"));
    await expectError(failing, "POST_CHECK_FAILED");
    expect(failing.audit).toHaveBeenCalledTimes(1);
    await expect(failing.audit.mock.results[0].value).resolves.toMatchObject({ report: { verdict: "passed" } });

    const stateB = fake();
    stateB.inspectDb.mockResolvedValueOnce({ state: STATE_C, privileges: PRIVILEGES, server: SERVER }).mockResolvedValueOnce({ state: { state: "B", reasons: ["x"] }, privileges: PRIVILEGES, server: SERVER });
    await expectError(stateB, "POST_STATE_MISMATCH");

    const moved = fake();
    moved.inspectDb.mockResolvedValueOnce({ state: STATE_C, privileges: PRIVILEGES, server: SERVER }).mockResolvedValueOnce({ state: STATE_C, privileges: PRIVILEGES, server: { ...SERVER, postmasterStartTime: "2026-11-06T22:46:51.123457Z" } });
    await expectError(moved, "POST_IDENTITY_MISMATCH");
    for (const f of [failing, stateB, moved]) expect(f.logs.join("\n")).not.toContain("audit passed");
  });

  it("17・18. D3 の失敗・変化は、監査が passed でも失敗（DOCKER_IDENTITY_FAILED・POST_IDENTITY_MISMATCH）", async () => {
    const failing = fake();
    failing.docker.mockResolvedValueOnce({ ...DOCKER }).mockResolvedValueOnce({ ...DOCKER }).mockRejectedValueOnce(Object.assign(new Error("x"), { code: "DOCKER_COMMAND_FAILED" }));
    expect((await expectError(failing, "DOCKER_IDENTITY_FAILED")).message).toContain("D3");
    expect(failing.audit).toHaveBeenCalledTimes(1);

    const changed = fake();
    changed.docker.mockResolvedValueOnce({ ...DOCKER }).mockResolvedValueOnce({ ...DOCKER }).mockResolvedValueOnce({ ...DOCKER, containerId: "d".repeat(64) });
    await expectError(changed, "POST_IDENTITY_MISMATCH");
    for (const f of [failing, changed]) expect(f.logs.join("\n")).not.toContain("audit passed");
  });
});

describe("静的な確認（ソース）", () => {
  const code = (file: string) =>
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "");

  it("スクリプトのゲートは固定の読み取り専用の有効値（Step 3-12B-5D-2 で一時的に有効化）で、引数・環境変数から決めない", () => {
    const source = code("scripts/testdb-catalog.mts");
    expect(source.split("\n").filter((line) => line.includes("catalogDatabase"))).toEqual(['  catalogDatabase: { mode: "enabled-read-only" },']);
    expect(source.match(/process\.argv/g)).toHaveLength(1);
    expect(source).toMatch(/^ {2}argv: process\.argv\.slice\(2\),$/m);
    expect(source.match(/process\.env/g)).toHaveLength(1);
    expect(source).toMatch(/^ {2}parentEnv: process\.env,$/m);
  });

  it("新しいゲートは凍結された無効値で、migration・checksum・schemaDiff のゲートとは別の値。既存の3つのゲートは無効のまま", () => {
    expect(CATALOG_AUDIT_DATABASE_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(CATALOG_AUDIT_DATABASE_DISABLED)).toBe(true);
    for (const other of [LIVE_DATABASE_DISABLED, CHECKSUM_DATABASE_DISABLED, SCHEMA_DIFF_DISABLED]) {
      expect(CATALOG_AUDIT_DATABASE_DISABLED).not.toBe(other);
      expect(other).toEqual({ mode: "disabled" });
    }
    expect(code("scripts/testdb-migrate.mts")).toMatch(/^ {2}liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(code("scripts/testdb-checksums.mts")).toMatch(/^ {2}checksumDatabase: CHECKSUM_DATABASE_DISABLED,$/m);
    expect(EXPECTED_CATALOG_MIGRATION_COUNT).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it("20. カタログの監査の経路は、Prisma CLI・migration・checksum・schemaDiff・読み取り専用ロールの検査に到達しない", () => {
    for (const file of ["scripts/testdb-catalog.mts", "lib/testing/testDbCatalogRunner.ts"]) {
      const source = code(file);
      for (const forbidden of [
        "child_process",
        "spawn",
        "execFile",
        "PRISMA_CLI_ENTRY",
        "migrate deploy",
        "runTestDbMigrate",
        "liveDatabase",
        "LIVE_DATABASE_DISABLED",
        "runTestDbChecksums",
        "inspectMigrationChecksums",
        "migrationChecksum",
        "CHECKSUM_DATABASE",
        "schemaDiff",
        "SCHEMA_DIFF",
        "readReadOnlyRoleSnapshot",
        "classifyReadOnlyRoleSnapshot",
        "readOnlyRoleExpectation",
        "@prisma/client",
        "@/lib/prisma",
        '"pg"',
        "writeFile",
        "--apply",
      ]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
    // 本体は DB ドライバ・Docker のコマンドを直接読み込まない（スクリプトから注入する）
    const lib = code("lib/testing/testDbCatalogRunner.ts");
    for (const forbidden of ["testDbConnection", "testDbDocker", "runDockerCommand"]) expect(lib).not.toContain(forbidden);
    // スクリプトは監査を runCatalogDefinitionAudit（katana_test_user の読み取り専用の接続）にだけつなぐ
    expect(code("scripts/testdb-catalog.mts")).toMatch(/^ {2}runAudit: \(input\) => runCatalogDefinitionAudit\(\{ \.\.\.input, connect: connectTestDatabase \}\),$/m);
  });

  it("npm の testdb:catalog は、引数なし（予行）でスクリプトを実行する。--verify 付きの npm スクリプトはない", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:catalog"]).toBe("node scripts/testdb-catalog.mts");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("testdb-catalog.mts"))).toEqual(["node scripts/testdb-catalog.mts"]);
  });
});
