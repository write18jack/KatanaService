import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type IntegrationDbClient, MIGRATIONS_TABLE, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import {
  assertCatalogFingerprintUnchanged,
  buildCatalogAuditExpectation,
  buildCatalogFingerprint,
  CATALOG_COLUMNS_SQL,
  CATALOG_FINGERPRINT_SECTIONS,
  type CatalogAuditError,
  type CatalogAuditExpectation,
  catalogAuditPassed,
  classifyReadOnlyRoleSnapshot,
  compareCatalogFingerprints,
  DB_SPECIFIC_CONSTRAINTS_SQL,
  ENUM_VALUES_SQL,
  enumValuesFromSchema,
  loadCatalogAuditExpectation,
  NON_PLAIN_INDEXES_SQL,
  POLICIES_SQL,
  READ_ONLY_ROLE,
  readOnlyRoleExpectation,
  readReadOnlyRoleSnapshot,
  replayEnumsFromMigrations,
  ROLE_ATTRIBUTES_SQL,
  ROLE_DATABASE_PRIVILEGES_SQL,
  ROLE_MEMBERSHIPS_SQL,
  ROLE_OWNERSHIP_SQL,
  ROLE_SEQUENCE_PRIVILEGES_SQL,
  ROLE_TABLE_PRIVILEGES_SQL,
  ROW_SECURITY_SQL,
  runCatalogDefinitionAudit,
  scanMigrationsForDbSpecificDefinitions,
  VISIBLE_COLUMNS_SQL,
} from "./testDbCatalogAudit";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { SERVER_IDENTITY_SQL } from "./testDbState";

// 偽の DB クライアントだけを使う（DB・Docker に接続せず、Prisma CLI も起動しない）。
// 期待値は、リポジトリの prisma/schema.prisma と prisma/migrations を読むだけで作る。
const REPO_ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "catalog-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "catalog-dev-dummy";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"];

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

const EXPECTED = loadCatalogAuditExpectation(REPO_ROOT);
const ENUMS = EXPECTED.enums.status === "supported" ? EXPECTED.enums.enums : {};
const TABLES = [...EXPECTED.inventory.tables, MIGRATIONS_TABLE];

type Rows = Record<string, unknown>[];

/** 状態 C の判定（readCatalogInventory）の SQL は export されていないので、内容で見分ける */
function inventoryRows(sql: string, o: FakeOptions): Rows | undefined {
  if (sql.includes('"ownerSchema"')) {
    return o.relations ?? TABLES.map((name) => ({ schema: "public", name, kind: "r", ownerSchema: null, ownerTable: null }));
  }
  if (sql.includes("t.typelem")) return o.types ?? Object.keys(ENUMS).map((name) => ({ schema: "public", name, kind: "e" }));
  if (sql.includes("p.prokind AS kind")) return o.routines ?? [];
  if (sql.includes("operator class")) return o.otherObjects ?? [];
  if (sql.includes("FROM pg_catalog.pg_extension e") && !sql.includes("extversion")) return (o.extensions ?? ["plpgsql"]).map((name) => ({ name }));
  if (sql.includes("FROM pg_catalog.pg_namespace n") && sql.includes("SELECT n.nspname AS name") && !sql.includes("nspowner")) return [{ name: "public" }];
  return undefined;
}

/** enum の行（enumsortorder の逆順で返し、SQL の結果の順序に頼らないことを確かめる） */
function enumRows(enums: Record<string, readonly string[]> = ENUMS): Rows {
  return Object.entries(enums)
    .flatMap(([name, values]) => values.map((value, i) => ({ enum: name, value, sortOrder: i + 1 })))
    .reverse();
}

function fingerprintRows(): Record<string, Rows> {
  return {
    database: [{ name: "katana_test", owner: "katana_test_user", acl: null, comment: "katana-test-db" }],
    schemas: [{ name: "public", owner: "pg_database_owner", acl: "{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}" }],
    extensions: [{ name: "plpgsql", version: "1.0", schema: "pg_catalog" }],
    relations: [
      { schema: "public", name: "User", kind: "r", persistence: "p", rowSecurity: false, forceRowSecurity: false, owner: "katana_test_user", acl: null },
      { schema: "public", name: "User_pkey", kind: "i", persistence: "p", rowSecurity: false, forceRowSecurity: false, owner: "katana_test_user", acl: null },
    ],
    columns: [
      { schema: "public", table: "User", name: "id", position: 1, type: "text", notNull: true, default: null, identity: "", generated: "", collation: "default", acl: null },
      {
        schema: "public",
        table: "User",
        name: "createdAt",
        position: 2,
        type: "timestamp(3) without time zone",
        notNull: true,
        default: "CURRENT_TIMESTAMP",
        identity: "",
        generated: "",
        collation: null,
        acl: null,
      },
    ],
    constraints: [{ schema: "public", table: "User", name: "User_pkey", type: "p", definition: "PRIMARY KEY (id)", deferrable: false, deferred: false, validated: true }],
    indexes: [
      { schema: "public", name: "User_pkey", table: "User", definition: 'CREATE UNIQUE INDEX "User_pkey" ON public."User" USING btree (id)', primary: true, unique: true, valid: true },
    ],
    types: [{ schema: "public", name: "UserRole", kind: "e", owner: "katana_test_user", acl: null }],
    enumValues: [
      { schema: "public", enum: "UserRole", value: "ADMIN", position: 1 },
      { schema: "public", enum: "UserRole", value: "STORE", position: 2 },
    ],
    sequences: [],
    routines: [],
    triggers: [],
    policies: [],
    defaultPrivileges: [],
    roles: [
      {
        name: "katana_test_user",
        superuser: false,
        inherit: true,
        createRole: false,
        createDb: false,
        login: true,
        replication: false,
        bypassRls: false,
        connectionLimit: -1,
        config: null,
      },
    ],
    // ALTER ROLE … IN DATABASE … SET・ALTER DATABASE … SET・ALTER ROLE … SET（全DB）。設定値は md5 の値だけ
    dbRoleSettings: [
      { databaseScope: "one", database: "katana_test", roleScope: "one", role: "katana_test_ro", configHash: "a".repeat(32) },
      { databaseScope: "one", database: "katana_test", roleScope: "all", role: "", configHash: "b".repeat(32) },
      { databaseScope: "all", database: "", roleScope: "one", role: "katana_test_ro", configHash: "c".repeat(32) },
    ],
    roleMemberships: [],
    largeObjects: [],
  };
}

type FakeOptions = {
  relations?: Rows;
  types?: Rows;
  routines?: Rows;
  otherObjects?: Rows;
  extensions?: string[];
  constraints?: Rows;
  indexes?: Rows;
  rowSecurity?: Rows;
  policies?: Rows;
  enums?: Rows;
  readOnly?: string;
  marker?: string;
  server?: TestDatabaseServerIdentity;
  failOn?: string;
  failRollback?: boolean;
  failEnd?: boolean;
  failConnect?: boolean;
  failBegin?: boolean;
};

function fakeDb(o: FakeOptions = {}) {
  const queries: string[] = [];
  const end = vi.fn(async () => {
    if (o.failEnd) throw Object.assign(new Error(`end failed ${TEST_URL}`), { code: "ECONNRESET" });
  });
  const exact = new Map<string, Rows>([
    [SERVER_IDENTITY_SQL, [{ ...(o.server ?? SERVER) }]],
    [DB_SPECIFIC_CONSTRAINTS_SQL, o.constraints ?? []],
    [NON_PLAIN_INDEXES_SQL, o.indexes ?? []],
    [ROW_SECURITY_SQL, o.rowSecurity ?? []],
    [POLICIES_SQL, o.policies ?? []],
    [ENUM_VALUES_SQL, o.enums ?? enumRows()],
    ...Object.entries(CATALOG_FINGERPRINT_SECTIONS).map(([name, spec]) => [spec.sql, fingerprintRows()[name]] as [string, Rows]),
  ]);
  const client: IntegrationDbClient = {
    query: async (sql) => {
      queries.push(sql);
      if (o.failOn && sql.includes(o.failOn)) throw Object.assign(new Error(`boom ${TEST_URL} ${PASSWORD}`), { code: "42501" });
      if (sql === "BEGIN READ ONLY") {
        if (o.failBegin) throw Object.assign(new Error("begin failed"), { code: "57P01" });
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (o.failRollback) throw Object.assign(new Error(`rollback failed ${PASSWORD}`), { code: "08006" });
        return { rows: [] };
      }
      const known = exact.get(sql);
      if (known !== undefined) return { rows: known };
      if (sql.includes("set_config('search_path'")) return { rows: [{ searchPath: "pg_catalog" }] };
      if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: o.readOnly ?? "on" }] };
      if (sql.includes('session_user AS "sessionUser"') && sql.includes("AS marker")) {
        return {
          rows: [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: o.marker ?? TEST_DATABASE_MARKER, serverPort: 5432 }],
        };
      }
      const inventory = inventoryRows(sql, o);
      if (inventory !== undefined) return { rows: inventory };
      throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
    },
    end,
  };
  const connect = vi.fn(async () => {
    if (o.failConnect) throw Object.assign(new Error(`connect failed ${TEST_URL}`), { code: "ECONNREFUSED" });
    return client;
  });
  return { queries, end, connect };
}

const run = (db: ReturnType<typeof fakeDb>, expectation: CatalogAuditExpectation = EXPECTED, databaseUrl = TEST_URL) =>
  runCatalogDefinitionAudit({ databaseUrl, developmentDatabaseUrl: DEV_URL, connect: db.connect, expectation, expectedServer: { docker: DOCKER, server: SERVER } });

async function auditError(promise: Promise<unknown>): Promise<CatalogAuditError> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).name).toBe("CatalogAuditError");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    return error as CatalogAuditError;
  }
  throw new Error("expected a CatalogAuditError");
}

const categories = (result: { findings: readonly { category: string }[] }) => result.findings.map((f) => f.category).sort();
const items = (result: { findings: readonly { items: readonly string[] }[] }) => result.findings.flatMap((f) => f.items).join("\n");

describe("期待値（リポジトリのファイルから。DB から独立）", () => {
  it("今の schema.prisma と8件の migration から、テーブル15件・enum 5件の値と順序を確定できる。DB 固有の定義は migration にない", () => {
    expect(EXPECTED.inventory.tables).toHaveLength(15);
    expect(EXPECTED.inventory.migrations).toHaveLength(8);
    expect(EXPECTED.dbSpecific).toEqual({ status: "supported" });
    expect(EXPECTED.enums.status).toBe("supported");
    expect(ENUMS).toEqual({
      ImportRowStatus: ["SUCCESS", "ERROR", "SKIPPED"],
      ImportStatus: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
      ProductHistoryAction: ["CREATE", "UPDATE", "DELETE", "IMPORT", "PRICE_CHANGE", "STATUS_CHANGE"],
      ProductStatus: ["ACTIVE", "SOLD"],
      UserRole: ["ADMIN", "STORE"],
    });
    // 途中で作って削除した enum（Era・KatanaType）は残らない
    expect(Object.keys(ENUMS)).not.toContain("Era");
  });

  it("enum の順序は migration の再現で決める（ADD VALUE の BEFORE・AFTER・末尾、RENAME、DROP）", () => {
    const replayed = replayEnumsFromMigrations([
      { name: "1", sql: `-- CreateEnum\nCREATE TYPE "S" AS ENUM ('A', 'C');\nCREATE TYPE "Old" AS ENUM ('X');` },
      { name: "2", sql: `ALTER TYPE "S" ADD VALUE 'B' BEFORE 'C';\nALTER TYPE "S" ADD VALUE 'D';\nALTER TYPE "S" ADD VALUE 'Z' AFTER 'A';` },
      { name: "3", sql: `ALTER TYPE "S" RENAME VALUE 'Z' TO 'AA';\nALTER TYPE "Old" RENAME TO "New";\nDROP TYPE IF EXISTS "Missing";` },
    ]);
    expect(replayed).toEqual({ status: "supported", enums: { New: ["X"], S: ["A", "AA", "B", "C", "D"] } });
  });

  it("Prisma が先頭に書くブロックコメント（Warnings）は除いて文を分ける。閉じていないブロックコメントは unsupported", () => {
    const warnings = `/*\n  Warnings:\n  - You are about to drop the enum. CHECK (x) ; CREATE TYPE "Fake" AS ENUM ('Z');\n*/\n-- CreateEnum\nCREATE TYPE "S" AS ENUM ('A');`;
    expect(replayEnumsFromMigrations([{ name: "m", sql: warnings }])).toEqual({ status: "supported", enums: { S: ["A"] } });
    expect(scanMigrationsForDbSpecificDefinitions([{ name: "m", sql: warnings }])).toEqual({ status: "supported" });
    const unclosed = `/* Warnings\nCREATE TYPE "S" AS ENUM ('A');`;
    expect(replayEnumsFromMigrations([{ name: "m", sql: unclosed }]).status).toBe("unsupported");
    expect(scanMigrationsForDbSpecificDefinitions([{ name: "m", sql: unclosed }]).status).toBe("unsupported");
  });

  it("対応していない TYPE の文・未知の enum への操作は、推測せずに unsupported にする", () => {
    for (const sql of [`CREATE TYPE "P" AS (a int);`, `ALTER TYPE "Q" ADD VALUE 'x';`, `DROP TYPE "Unknown";`, `ALTER TYPE "S" OWNER TO someone;`]) {
      expect(replayEnumsFromMigrations([{ name: "m", sql: `CREATE TYPE "S" AS ENUM ('A');\n${sql}` }]).status).toBe("unsupported");
    }
  });

  it("migration と schema.prisma の enum の値が食い違えば、期待値を確定できない（unsupported）", () => {
    const schemaSource = readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
    const migrations = EXPECTED.inventory.migrations.map((name) => ({ name, sql: readFileSync(path.join(REPO_ROOT, "prisma", "migrations", name, "migration.sql"), "utf8") }));
    const drifted = buildCatalogAuditExpectation({ schemaSource: schemaSource.replace(/enum UserRole \{\n {2}ADMIN/, "enum UserRole {\n  OWNER\n  ADMIN"), migrations });
    expect(drifted.enums.status).toBe("unsupported");
    expect(enumValuesFromSchema(schemaSource).UserRole).toEqual(["ADMIN", "STORE"]);
  });

  it("migration に DB 固有の定義・単純でないインデックスがあれば、期待値を確定できない（永久に0件とは決めつけない）", () => {
    for (const sql of [
      `ALTER TABLE "T" ADD CONSTRAINT "c" CHECK ("x" > 0);`,
      `ALTER TABLE "T" ADD CONSTRAINT "e" EXCLUDE USING gist ("r" WITH &&);`,
      `ALTER TABLE "T" ENABLE ROW LEVEL SECURITY;`,
      `CREATE POLICY "p" ON "T" USING (true);`,
      `CREATE TRIGGER "t" BEFORE INSERT ON "T" FOR EACH ROW EXECUTE FUNCTION f();`,
      `CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;`,
      `CREATE MATERIALIZED VIEW "v" AS SELECT 1;`,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm;`,
      `CREATE INDEX "i" ON "T"("x") WHERE "x" IS NOT NULL;`,
      `CREATE INDEX "j" ON "T"(lower("x"));`,
    ]) {
      expect(scanMigrationsForDbSpecificDefinitions([{ name: "m", sql }]).status, sql).toBe("unsupported");
    }
    expect(scanMigrationsForDbSpecificDefinitions([{ name: "m", sql: `-- CHECK ( in a comment\nCREATE UNIQUE INDEX "a" ON "T"("x", "y");` }])).toEqual({ status: "supported" });
  });
});

describe("定義の検査（偽の DB クライアント）", () => {
  it("1. 正常：passed。BEGIN READ ONLY → search_path → transaction_read_only → 本人確認 → サーバーの識別 → SELECT → ROLLBACK → 接続の解放", async () => {
    const db = fakeDb();
    const result = await run(db);
    expect(result.report).toEqual({ verdict: "passed", findings: [] });
    expect(catalogAuditPassed(result.report)).toBe(true);
    expect(result.fingerprint.meaning).toBe("observed-catalog-definition");
    expect(db.connect).toHaveBeenCalledWith(TEST_URL);
    expect(db.queries[0]).toBe("BEGIN READ ONLY");
    expect(db.queries[1]).toContain("set_config('search_path', 'pg_catalog', true)");
    expect(db.queries[2]).toBe("SHOW transaction_read_only");
    expect(db.queries[3]).toContain("AS marker");
    expect(db.queries[4]).toBe(SERVER_IDENTITY_SQL);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    for (const q of db.queries.slice(1, -1)) expect(q.trimStart()).toMatch(/^(SELECT|SHOW|WITH) /);
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["2. CHECK 制約", { constraints: [{ table: "Product", name: "Product_price_check", type: "c" }] }, "check constraint"],
    ["3. 除外制約", { constraints: [{ table: "Product", name: "Product_excl", type: "x" }] }, "exclusion constraint"],
    ["4. 制約トリガー", { constraints: [{ table: "Product", name: "Product_ct", type: "t" }] }, "constraint trigger"],
    ["4. ユーザー定義トリガー（状態 C の判定を再利用）", { otherObjects: [{ kind: "trigger", count: 1 }] }, "trigger (1)"],
    ["5. 関数（状態 C の判定を再利用）", { routines: [{ schema: "public", name: "f", kind: "f" }] }, "public.f (f)"],
    [
      "5. ビュー（状態 C の判定を再利用）",
      { relations: [...TABLES.map((name) => ({ schema: "public", name, kind: "r", ownerSchema: null, ownerTable: null })), { schema: "public", name: "v", kind: "v", ownerSchema: null, ownerTable: null }] },
      "public.v (v)",
    ],
    ["6. RLS の設定", { rowSecurity: [{ table: "Product", enabled: true, forced: false }] }, "Product (row level security)"],
    ["6. RLS のポリシー", { policies: [{ table: "Product", name: "p" }] }, "Product.p (policy)"],
    ["7. 部分インデックス", { indexes: [{ table: "Product", name: "Product_partial", partial: true, expression: false }] }, "partial index"],
    ["7. 式インデックス", { indexes: [{ table: "Product", name: "Product_expr", partial: false, expression: true }] }, "expression index"],
    ["8. 想定外の拡張", { extensions: ["plpgsql", "pg_trgm"] }, "pg_trgm"],
  ] as [string, FakeOptions, string][])("%s：UNEXPECTED_OBJECT で failed", async (_name, options, expectedItem) => {
    const result = await run(fakeDb(options));
    expect(result.report.verdict).toBe("failed");
    expect(categories(result.report)).toContain("UNEXPECTED_OBJECT");
    expect(items(result.report)).toContain(expectedItem);
  });

  it("想定外のスキーマ・テーブルの不足は、状態 C の判定の理由を UNEXPECTED_OBJECT・MISSING_OBJECT に分ける", async () => {
    const result = await run(fakeDb({ relations: TABLES.filter((t) => t !== "Product").map((name) => ({ schema: "public", name, kind: "r", ownerSchema: null, ownerTable: null })) }));
    expect(result.report.verdict).toBe("failed");
    expect(categories(result.report)).toEqual(["MISSING_OBJECT"]);
    expect(items(result.report)).toContain("Product");
  });

  it("9. enum の値の不一致：ENUM_MISMATCH（values differ）", async () => {
    const result = await run(fakeDb({ enums: enumRows({ ...ENUMS, UserRole: ["ADMIN", "OWNER"] }) }));
    expect(result.report.verdict).toBe("failed");
    expect(result.report.findings).toEqual([{ category: "ENUM_MISMATCH", items: ["enum UserRole: values differ"] }]);
  });

  it("10. enum の並び順の不一致：ENUM_MISMATCH（order differs）。DB の値を期待値として使わない", async () => {
    const result = await run(fakeDb({ enums: enumRows({ ...ENUMS, ImportStatus: ["PENDING", "COMPLETED", "PROCESSING", "FAILED"] }) }));
    expect(result.report.findings).toEqual([{ category: "ENUM_MISMATCH", items: ["enum ImportStatus: order differs"] }]);
  });

  it("期待値を確定できない項目があれば unverified で、成功とは扱わない", async () => {
    const result = await run(fakeDb(), { ...EXPECTED, enums: { status: "unsupported", reasons: ["m: unsupported TYPE statement"] } });
    expect(result.report.verdict).toBe("unverified");
    expect(catalogAuditPassed(result.report)).toBe(false);
    expect(categories(result.report)).toEqual(["EXPECTATION_UNSUPPORTED"]);
  });

  it("18. NULL・不正な型の行は INVALID_CATALOG_RESULT（ないもの・0件とは扱わない）", async () => {
    for (const options of [
      { constraints: [{ table: "Product", name: null, type: "c" }] },
      { indexes: [{ table: "Product", name: "i", partial: "yes", expression: false }] },
      { enums: [{ enum: "UserRole", value: "ADMIN", sortOrder: null }] },
      { enums: [{ enum: "UserRole", value: "ADMIN", sortOrder: 1 }, { enum: "UserRole", value: "STORE", sortOrder: 1 }] },
    ] as FakeOptions[]) {
      const db = fakeDb(options);
      expect((await auditError(run(db))).code).toBe("INVALID_CATALOG_RESULT");
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
    }
  });

  it("19. SQL の失敗：CATALOG_QUERY_FAILED（ROLLBACK・接続の解放。ドライバのメッセージ・URL・パスワードを表示しない）", async () => {
    for (const failOn of ["pg_constraint con", "pg_enum e", "operator class", "pg_get_indexdef"]) {
      const db = fakeDb({ failOn });
      const error = await auditError(run(db));
      expect(error.code).toBe("CATALOG_QUERY_FAILED");
      expect(error.message).toContain("42501");
      expect(error.message).not.toContain("boom");
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
    }
  });

  it("20. 本人確認の失敗（transaction_read_only・DB のコメント）：IDENTITY_CHECK_FAILED で、カタログを読まない", async () => {
    for (const options of [{ readOnly: "off" }, { marker: "other-db" }]) {
      const db = fakeDb(options);
      expect((await auditError(run(db))).code).toBe("IDENTITY_CHECK_FAILED");
      expect(db.queries.some((q) => q.includes("pg_constraint") || q.includes("pg_enum"))).toBe(false);
      expect(db.queries).not.toContain(SERVER_IDENTITY_SQL);
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
    }
  });

  it("21. サーバーの識別の不一致（IP・ポート・起動時刻）：SERVER_IDENTITY_MISMATCH で、カタログを読まない", async () => {
    for (const server of [
      { ...SERVER, serverAddress: "172.18.0.9" },
      { ...SERVER, serverPort: 5433 },
      { ...SERVER, postmasterStartTime: "2026-11-06T22:46:51.123457Z" },
    ]) {
      const db = fakeDb({ server });
      expect((await auditError(run(db))).code).toBe("SERVER_IDENTITY_MISMATCH");
      expect(db.queries.at(-2)).toBe(SERVER_IDENTITY_SQL);
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
    }
  });

  it("22. ROLLBACK・接続の解放の失敗は TRANSACTION_CLOSE_FAILED（検査が成功していても成功にしない）。接続・開始の失敗も区別する", async () => {
    const rollback = fakeDb({ failRollback: true });
    expect((await auditError(run(rollback))).code).toBe("TRANSACTION_CLOSE_FAILED");
    expect(rollback.end).toHaveBeenCalledTimes(1);
    const close = fakeDb({ failEnd: true });
    expect((await auditError(run(close))).code).toBe("TRANSACTION_CLOSE_FAILED");
    const connect = fakeDb({ failConnect: true });
    expect((await auditError(run(connect))).code).toBe("CONNECT_FAILED");
    expect(connect.queries).toEqual([]);
    const begin = fakeDb({ failBegin: true });
    expect((await auditError(run(begin))).code).toBe("CATALOG_QUERY_FAILED");
    expect(begin.queries).toEqual(["BEGIN READ ONLY"]);
    expect(begin.end).toHaveBeenCalledTimes(1);
  });

  it("接続先の検証に通らない URL（開発用DB・別のホスト）では、接続しない（TARGET_REJECTED）", async () => {
    for (const url of [DEV_URL, `postgresql://katana_test_user:${PASSWORD}@db.example.com:5434/katana_test`]) {
      const db = fakeDb();
      expect((await auditError(run(db, EXPECTED, url))).code).toBe("TARGET_REJECTED");
      expect(db.connect).not.toHaveBeenCalled();
    }
  });
});

describe("読み取り専用ロールの検査（将来の katana_test_ro。偽の DB クライアントだけ）", () => {
  const ROLE = "katana_test_ro";
  const columnRows = () => TABLES.flatMap((table) => [{ table, column: "id" }, { table, column: "createdAt" }]);
  type RoleOptions = { role?: Record<string, unknown>; memberships?: Rows; ownership?: Rows; database?: Record<string, unknown>; tables?: Rows; sequences?: Rows; visible?: Rows };
  const goodTable = (table: string) => ({ table, select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false });

  function roleClient(o: RoleOptions = {}) {
    const queries: string[] = [];
    const rows = new Map<string, Rows>([
      [
        ROLE_ATTRIBUTES_SQL,
        [
          {
            currentUser: ROLE,
            sessionUser: ROLE,
            superuser: false,
            inherit: false,
            createRole: false,
            createDb: false,
            replication: false,
            bypassRls: false,
            defaultReadOnly: "on",
            ...o.role,
          },
        ],
      ],
      [ROLE_MEMBERSHIPS_SQL, o.memberships ?? []],
      [ROLE_OWNERSHIP_SQL, o.ownership ?? ["relation", "type", "schema", "routine", "database", "large object", "default privileges"].map((kind) => ({ kind, count: 0 }))],
      [ROLE_DATABASE_PRIVILEGES_SQL, [{ databaseCreate: false, databaseTemporary: false, schemaCreate: false, schemaUsage: true, ...o.database }]],
      [ROLE_TABLE_PRIVILEGES_SQL, o.tables ?? TABLES.map(goodTable)],
      [ROLE_SEQUENCE_PRIVILEGES_SQL, o.sequences ?? []],
      [CATALOG_COLUMNS_SQL, columnRows()],
      // 結果の順序が違っても同じに扱う
      [VISIBLE_COLUMNS_SQL, o.visible ?? [...columnRows()].reverse()],
    ]);
    const client: IntegrationDbClient = {
      query: async (sql) => {
        queries.push(sql);
        const found = rows.get(sql);
        if (found === undefined) throw new Error("unexpected SQL in test");
        return { rows: found };
      },
      end: vi.fn(async () => undefined),
    };
    return { client, queries };
  }
  const classify = async (o: RoleOptions = {}) => {
    const { client, queries } = roleClient(o);
    const result = classifyReadOnlyRoleSnapshot(await readReadOnlyRoleSnapshot(client), readOnlyRoleExpectation(EXPECTED));
    return { result, queries };
  };

  it("正常：期待するテーブル（schema.prisma の15件と _prisma_migrations）がすべて SELECT 付きで見え、書き込み権限・所有権・所属がない", async () => {
    const { result, queries } = await classify();
    expect(readOnlyRoleExpectation(EXPECTED).tables).toContain(MIGRATIONS_TABLE);
    expect(readOnlyRoleExpectation(EXPECTED).tables).toHaveLength(16);
    expect(result).toEqual({ verdict: "passed", findings: [] });
    for (const q of queries) expect(q.trimStart()).toMatch(/^(SELECT|WITH) /);
  });

  it("11. 列の可視性が不足（information_schema.columns に現れない列）：COLUMN_VISIBILITY_INSUFFICIENT（列名の集合で比べる）", async () => {
    const visible = columnRows().filter((c) => !(c.table === "Product" && c.column === "createdAt"));
    // 件数を合わせても、名前が違えば検出する
    visible.push({ table: "Product", column: "ghost" });
    const { result } = await classify({ visible });
    expect(result.verdict).toBe("failed");
    expect(result.findings).toEqual([
      { category: "COLUMN_VISIBILITY_INSUFFICIENT", items: ["Product.createdAt: not visible in information_schema.columns", "Product.ghost: visible but not found in pg_attribute"] },
    ]);
  });

  it("12. テーブル単位の SELECT がない・スキーマの USAGE がない：COLUMN_VISIBILITY_INSUFFICIENT", async () => {
    const { result } = await classify({ tables: TABLES.map((t) => (t === "Shop" ? { ...goodTable(t), select: false } : goodTable(t))), database: { schemaUsage: false } });
    expect(result.findings).toEqual([{ category: "COLUMN_VISIBILITY_INSUFFICIENT", items: ["Shop: no table-level SELECT", "schema public USAGE"] }]);
  });

  it("13. 書き込み権限（テーブル・sequence・DB の CREATE・TEMPORARY・スキーマの CREATE）：READ_ONLY_ROLE_PRIVILEGE_VIOLATION", async () => {
    const { result } = await classify({
      tables: TABLES.map((t) => (t === "Product" ? { ...goodTable(t), insert: true, truncate: true } : goodTable(t))),
      sequences: [{ name: "seq", usage: true, update: false }],
      database: { databaseCreate: true, databaseTemporary: true, schemaCreate: true },
    });
    expect(result.verdict).toBe("failed");
    expect(result.findings).toEqual([
      {
        category: "READ_ONLY_ROLE_PRIVILEGE_VIOLATION",
        items: ["Product INSERT", "Product TRUNCATE", "database CREATE", "database TEMPORARY", "schema public CREATE", "sequence seq USAGE"],
      },
    ]);
  });

  it("14. 所有権・ロールの所属・ロールの属性・default_transaction_read_only：READ_ONLY_ROLE_PRIVILEGE_VIOLATION", async () => {
    const ownership = ["relation", "type", "schema", "routine", "database", "large object", "default privileges"].map((kind) => ({ kind, count: kind === "relation" ? 2 : 0 }));
    const { result } = await classify({ ownership, memberships: [{ role: "katana_test_user" }], role: { superuser: true, inherit: true, defaultReadOnly: "off" } });
    expect(result.findings).toEqual([
      {
        category: "READ_ONLY_ROLE_PRIVILEGE_VIOLATION",
        items: ["default_transaction_read_only is not on", "member of role katana_test_user", "owns relation (2)", "role attribute inherit", "role attribute superuser"],
      },
    ]);
  });

  it("INSERT・UPDATE・REFERENCES は has_any_column_privilege（列単位も数える）、SELECT・DELETE・TRUNCATE・TRIGGER は has_table_privilege で読む", () => {
    const fn = (alias: string) => new RegExp(String.raw`pg_catalog\.(has_\w+_privilege)\(c\.oid, '[A-Z]+'\) AS "${alias}"`).exec(ROLE_TABLE_PRIVILEGES_SQL)?.[1];
    expect(["insert", "update", "references"].map(fn)).toEqual(Array(3).fill("has_any_column_privilege"));
    expect(["select", "delete", "truncate", "trigger"].map(fn)).toEqual(Array(4).fill("has_table_privilege"));
  });

  it.each([
    ["列単位の INSERT だけ", { insert: true }, "Product INSERT"],
    ["列単位の UPDATE だけ", { update: true }, "Product UPDATE"],
    ["列単位の REFERENCES だけ", { references: true }, "Product REFERENCES"],
    ["テーブル単位の DELETE", { delete: true }, "Product DELETE"],
    ["テーブル単位の TRIGGER", { trigger: true }, "Product TRIGGER"],
  ])("%s（SELECT はあり）：READ_ONLY_ROLE_PRIVILEGE_VIOLATION で、ほかのテーブル・検査が正常でも全体は failed", async (_name, grant, item) => {
    const { result } = await classify({ tables: TABLES.map((t) => (t === "Product" ? { ...goodTable(t), ...grant } : goodTable(t))) });
    expect(result.verdict).toBe("failed");
    expect(catalogAuditPassed(result)).toBe(false);
    expect(result.findings).toEqual([{ category: "READ_ONLY_ROLE_PRIVILEGE_VIOLATION", items: [item] }]);
  });

  it("SELECT だけを持つロールは passed（書き込みの権限はすべて false）", async () => {
    const { result } = await classify({ tables: TABLES.map(goodTable) });
    expect(result).toEqual({ verdict: "passed", findings: [] });
  });

  it("判定の対象は katana_test_ro だけ（期待値・接続のどちらかが別のロールなら判定しない）", async () => {
    expect(readOnlyRoleExpectation(EXPECTED).role).toBe(READ_ONLY_ROLE);
    expect(READ_ONLY_ROLE).toBe("katana_test_ro");
    const { client } = roleClient();
    const snapshot = await readReadOnlyRoleSnapshot(client);
    const other = { ...readOnlyRoleExpectation(EXPECTED), role: "katana_test_user" } as unknown as ReturnType<typeof readOnlyRoleExpectation>;
    expect(() => classifyReadOnlyRoleSnapshot(snapshot, other)).toThrow(expect.objectContaining({ code: "IDENTITY_CHECK_FAILED" }));
    await expect(classify({ role: { sessionUser: "katana_test_user" } })).rejects.toMatchObject({ code: "IDENTITY_CHECK_FAILED" });
  });

  it("期待するテーブルの不足・想定外のテーブル、別のロールでの接続、所有権の種類の欠け・不正な型を検出する", async () => {
    const missing = await classify({ tables: [...TABLES.filter((t) => t !== "Shop"), "Extra"].map(goodTable) });
    expect(categories(missing.result)).toEqual(["MISSING_OBJECT", "UNEXPECTED_OBJECT"]);
    await expect(classify({ role: { currentUser: "katana_test_user" } })).rejects.toMatchObject({ code: "IDENTITY_CHECK_FAILED" });
    await expect(classify({ ownership: [{ kind: "relation", count: 0 }] })).rejects.toMatchObject({ code: "INVALID_CATALOG_RESULT" });
    await expect(classify({ tables: [{ ...goodTable("Shop"), select: null }] })).rejects.toMatchObject({ code: "INVALID_CATALOG_RESULT" });
  });
});

describe("カタログの fingerprint（2回の観測の比較。Prisma schema との一致の証拠ではない）", () => {
  it("15. 同じ定義なら一致する。meaning で、観測の比較であることを示す", () => {
    const a = buildCatalogFingerprint(fingerprintRows());
    const b = buildCatalogFingerprint(fingerprintRows());
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.meaning).toBe("observed-catalog-definition");
    expect(compareCatalogFingerprints(a, b)).toEqual({ unchanged: true, changes: [] });
    expect(() => assertCatalogFingerprintUnchanged(a, b)).not.toThrow();
  });

  it("17. 行の順序・列（キー）の順序が違っても同じと判定する", () => {
    const rows = fingerprintRows();
    const shuffled = Object.fromEntries(
      Object.entries(rows).map(([name, list]) => [name, [...list].reverse().map((row) => Object.fromEntries(Object.entries(row).reverse()))]),
    );
    expect(buildCatalogFingerprint(shuffled).sha256).toBe(buildCatalogFingerprint(rows).sha256);
  });

  it("16. 定義の変更・追加・削除を検出し、セクションとキーだけを報告する（定義の文字列は表示しない）", () => {
    const before = buildCatalogFingerprint(fingerprintRows());
    const rows = fingerprintRows();
    rows.columns[1] = { ...rows.columns[1], default: "now()" };
    rows.columns.splice(0, 1);
    rows.indexes.push({ schema: "public", name: "User_x_idx", table: "User", definition: "CREATE INDEX secret_def", primary: false, unique: false, valid: true });
    rows.roles[0] = { ...rows.roles[0], config: "0123456789abcdef0123456789abcdef" };
    const after = buildCatalogFingerprint(rows);
    const { unchanged, changes } = compareCatalogFingerprints(before, after);
    expect(unchanged).toBe(false);
    expect(changes).toEqual([
      { section: "columns", added: [], removed: ['["public","User","id"]'], changed: ['["public","User","createdAt"]'] },
      { section: "indexes", added: ['["public","User_x_idx"]'], removed: [], changed: [] },
      { section: "roles", added: [], removed: [], changed: ['["katana_test_user"]'] },
    ]);
    let message = "";
    try {
      assertCatalogFingerprintUnchanged(before, after);
    } catch (error) {
      expect((error as CatalogAuditError).code).toBe("FINGERPRINT_MISMATCH");
      message = (error as Error).message;
    }
    expect(message).toContain("columns (added 0, removed 1, changed 1)");
    expect(message).not.toContain("secret_def");
    expect(message).not.toContain("now()");
  });

  it("18. NULL・不正な型・キーの重複・読まれていないセクションは INVALID_CATALOG_RESULT", () => {
    const cases: ((rows: Record<string, Rows>) => void)[] = [
      (r) => (r.columns[0] = { ...r.columns[0], notNull: null }),
      (r) => (r.columns[0] = { ...r.columns[0], position: "1" }),
      (r) => (r.relations[0] = { ...r.relations[0], name: undefined }),
      (r) => r.indexes.push({ ...r.indexes[0] }),
      (r) => delete r.policies,
    ];
    for (const mutate of cases) {
      const rows = fingerprintRows();
      mutate(rows);
      expect(() => buildCatalogFingerprint(rows)).toThrow(expect.objectContaining({ code: "INVALID_CATALOG_RESULT" }));
    }
  });

  it("18区分が固定の順序で、行・列の順序に依存しない", () => {
    expect(Object.keys(CATALOG_FINGERPRINT_SECTIONS).sort()).toEqual([
      "columns",
      "constraints",
      "database",
      "dbRoleSettings",
      "defaultPrivileges",
      "enumValues",
      "extensions",
      "indexes",
      "largeObjects",
      "policies",
      "relations",
      "roleMemberships",
      "roles",
      "routines",
      "schemas",
      "sequences",
      "triggers",
      "types",
    ]);
    expect(Object.keys(buildCatalogFingerprint(fingerprintRows()).sections)).toHaveLength(18);
  });

  describe("DB 別・ロール別の設定（dbRoleSettings。pg_db_role_setting）", () => {
    const key = (database: string, role: string) =>
      JSON.stringify([database === "" ? "all" : "one", database, role === "" ? "all" : "one", role]);
    const changesOf = (mutate: (rows: Rows) => void) => {
      const rows = fingerprintRows();
      mutate(rows.dbRoleSettings);
      return compareCatalogFingerprints(buildCatalogFingerprint(fingerprintRows()), buildCatalogFingerprint(rows));
    };

    it("SQL は setdatabase = 0・setrole = 0 の行を LEFT JOIN で残し、OID を名前に変え、設定値は md5 にしてから読む", () => {
      const sql = CATALOG_FINGERPRINT_SECTIONS.dbRoleSettings.sql;
      expect(sql).toContain("FROM pg_catalog.pg_db_role_setting s");
      expect(sql).toContain("LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase");
      expect(sql).toContain("LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole");
      expect(sql).toContain("WHEN s.setdatabase = 0 THEN 'all'");
      expect(sql).toContain("WHEN s.setrole = 0 THEN 'all'");
      expect(sql).toContain("pg_catalog.md5(s.setconfig::text)");
      expect(sql.replace("pg_catalog.md5(s.setconfig::text)", "")).not.toContain("setconfig");
      expect(sql).not.toMatch(/\bWHERE\b/);
      expect(CATALOG_FINGERPRINT_SECTIONS.roles.sql).toContain("pg_catalog.md5(r.rolconfig::text)");
    });

    it.each([
      ["DB 別のロールの設定（ALTER ROLE … IN DATABASE … SET）", "katana_test", "katana_test_ro", 0],
      ["DB 全体の設定（ALTER DATABASE … SET）", "katana_test", "", 1],
      ["ロール全体の設定（ALTER ROLE … SET）", "", "katana_test_ro", 2],
    ])("%s の値の変更を検出する（キーだけを報告し、設定値・ハッシュを表示しない）", (_name, database, role, index) => {
      const { unchanged, changes } = changesOf((rows) => (rows[index] = { ...rows[index], configHash: "f".repeat(32) }));
      expect(unchanged).toBe(false);
      expect(changes).toEqual([{ section: "dbRoleSettings", added: [], removed: [], changed: [key(database, role)] }]);
      expect(JSON.stringify(changes)).not.toContain("f".repeat(32));
    });

    it("設定の追加・削除を検出する", () => {
      const added = changesOf((rows) => rows.push({ databaseScope: "one", database: "katana_test", roleScope: "one", role: "katana_test_user", configHash: "d".repeat(32) }));
      expect(added.changes).toEqual([{ section: "dbRoleSettings", added: [key("katana_test", "katana_test_user")], removed: [], changed: [] }]);
      const removed = changesOf((rows) => rows.splice(1, 1));
      expect(removed.changes).toEqual([{ section: "dbRoleSettings", added: [], removed: [key("katana_test", "")], changed: [] }]);
    });

    it("行の順序が変わっても同じ fingerprint", () => {
      expect(changesOf((rows) => rows.reverse())).toEqual({ unchanged: true, changes: [] });
    });

    it("NULL（名前を引けない OID）・不正な型・キーの重複は INVALID_CATALOG_RESULT（設定値を表示しない）", () => {
      for (const mutate of [
        (rows: Rows) => (rows[0] = { ...rows[0], database: null }),
        (rows: Rows) => (rows[0] = { ...rows[0], role: null }),
        (rows: Rows) => (rows[0] = { ...rows[0], configHash: 42 }),
        (rows: Rows) => rows.push({ ...rows[0], configHash: "e".repeat(32) }),
      ]) {
        const rows = fingerprintRows();
        mutate(rows.dbRoleSettings);
        let message = "";
        try {
          buildCatalogFingerprint(rows);
        } catch (error) {
          expect((error as CatalogAuditError).code).toBe("INVALID_CATALOG_RESULT");
          message = (error as Error).message;
        }
        expect(message).toContain("dbRoleSettings");
        for (const hash of ["a", "b", "c", "e"].map((c) => c.repeat(32))) expect(message).not.toContain(hash);
      }
    });

    it("取得に失敗したら CATALOG_QUERY_FAILED で、成功とは扱わない（ROLLBACK・接続の解放。URL・パスワードを表示しない）", async () => {
      const db = fakeDb({ failOn: "pg_db_role_setting" });
      const error = await auditError(run(db));
      expect(error.code).toBe("CATALOG_QUERY_FAILED");
      expect(error.message).toContain("fingerprint dbRoleSettings");
      expect(db.queries.at(-1)).toBe("ROLLBACK");
      expect(db.end).toHaveBeenCalledTimes(1);
    });
  });

  it("接続URL・パスワードなどの認証情報を含まない（カタログの SQL にパスワードの列を読むものがない）", () => {
    for (const spec of Object.values(CATALOG_FINGERPRINT_SECTIONS)) {
      expect(spec.sql).not.toMatch(/rolpassword|pg_authid|pg_shadow|pg_user_mapping|umoptions|srvoptions/i);
    }
    const json = JSON.stringify(buildCatalogFingerprint(fingerprintRows()));
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });
});

describe("静的な確認（ソース）", () => {
  const code = (file: string) =>
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const SQL_CONSTANTS = [
    DB_SPECIFIC_CONSTRAINTS_SQL,
    NON_PLAIN_INDEXES_SQL,
    ROW_SECURITY_SQL,
    POLICIES_SQL,
    ENUM_VALUES_SQL,
    ROLE_ATTRIBUTES_SQL,
    ROLE_MEMBERSHIPS_SQL,
    ROLE_OWNERSHIP_SQL,
    ROLE_DATABASE_PRIVILEGES_SQL,
    ROLE_TABLE_PRIVILEGES_SQL,
    ROLE_SEQUENCE_PRIVILEGES_SQL,
    CATALOG_COLUMNS_SQL,
    VISIBLE_COLUMNS_SQL,
    ...Object.values(CATALOG_FINGERPRINT_SECTIONS).map((s) => s.sql),
  ];

  it("このモジュールの SQL は読み取りだけ（1文の SELECT。文字列リテラル・引用符付きの別名を除いて、変更系のキーワード・set_config を含まない）", () => {
    for (const sql of SQL_CONSTANTS) {
      expect(sql.trimStart()).toMatch(/^(SELECT|WITH) /);
      const withoutLiterals = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
      expect(withoutLiterals).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|SET|LOCK|CALL|DO|NOTIFY|VACUUM|ANALYZE|REINDEX|CLUSTER)\b|set_config|lo_(?:create|creat|import|from_bytea|unlink|put)|pg_advisory|nextval|setval|;/i);
    }
  });

  it("24. DB ドライバ・Docker・子プロセス・Prisma を読み込まない（接続は引数の connect だけ）", () => {
    const source = code("lib/testing/testDbCatalogAudit.ts");
    for (const forbidden of ['from "pg"', "testDbConnection", "testDbDocker", "child_process", "@prisma/client", "@/lib/prisma", "node:net", "spawn", "execFile", "writeFile", "runDockerCommand"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("25. 呼び出し元はカタログの監査専用の経路（testDbCatalogRunner・testdb-catalog）と、読み取り専用ロールの準備の経路（testDbReadOnlyRole・testdb-ro-role。Step 3-12B-5E-3）と、schemaDiff の runner（testDbSchemaDiffRunner・testdb-schema-diff。Step 3-12B-5E-9A-9-2）だけで、schemaDiff の部品（schemaDiff.ts）・checksum・migration の経路からは呼ばない", () => {
    const allowedCallers = [
      "lib/testing/testDbCatalogRunner.ts",
      "scripts/testdb-catalog.mts",
      // 読み取り専用ロールの準備：FP0・FP1（runCatalogDefinitionAudit）と、R-base・R-full（readReadOnlyRoleSnapshot・classifyReadOnlyRoleSnapshot）に再利用する
      "lib/testing/testDbReadOnlyRole.ts",
      "lib/testing/testDbReadOnlyRoleRunner.ts",
      "scripts/testdb-ro-role.mts",
      // schemaDiff（Step 3-12B-5E-9A-9-2）：FP1・FP2（runCatalogDefinitionAudit）を、runner とスクリプトから使う。部品の schemaDiff.ts は使わない
      "lib/testing/testDbSchemaDiffRunner.ts",
      "scripts/testdb-schema-diff.mts",
    ];
    for (const file of allowedCallers) expect(readFileSync(path.join(REPO_ROOT, file), "utf8")).toContain("testDbCatalogAudit");
    const importers = [
      ...readdirSync(path.join(REPO_ROOT, "scripts")).map((f) => `scripts/${f}`),
      ...readdirSync(path.join(REPO_ROOT, "lib", "testing")).map((f) => `lib/testing/${f}`),
      "prisma.config.ts",
      // schemaDiff 専用の Prisma の設定ファイル（Step 3-12B-5E-9A-9-3A）：Prisma CLI のプロセスの中で読まれる。カタログの監査は使わない
      "prisma.schemadiff.config.ts",
      "package.json",
    ].filter((file) => file !== "lib/testing/testDbCatalogAudit.ts" && !allowedCallers.includes(file) && !file.endsWith(".test.ts") && /\.(m?ts|json)$/.test(file));
    expect(importers).toContain("lib/testing/schemaDiff.ts");
    expect(importers).toContain("scripts/testdb-checksums.mts");
    for (const file of importers) expect(readFileSync(path.join(REPO_ROOT, file), "utf8"), file).not.toContain("testDbCatalogAudit");
  });
});
