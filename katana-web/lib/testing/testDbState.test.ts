import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applicationTablesFromSchema, type IntegrationDbClient, listMigrationNames, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import {
  type CatalogInventory,
  type CatalogObject,
  type CatalogRelation,
  classifyCatalogInventory,
  classifyTestDatabase,
  type ClassifyTestDatabaseInput,
  enumNamesFromSchema,
  type TestDatabaseExpectation,
} from "./testDbState";

// DBには接続しない。接続はインメモリの偽のクライアントで置き換える（pg・Prisma Client は読み込まない）。
// 期待値は、実際の prisma/schema.prisma と prisma/migrations から読む（ファイルを読むだけ）
const ROOT = path.resolve(__dirname, "../..");
const SCHEMA_SOURCE = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const TABLES = applicationTablesFromSchema(SCHEMA_SOURCE);
const ENUMS = enumNamesFromSchema(SCHEMA_SOURCE);
const MIGRATIONS = listMigrationNames(path.join(ROOT, "prisma/migrations"));
const EXPECTED: TestDatabaseExpectation = { tables: TABLES, enums: ENUMS, migrations: MIGRATIONS };

const PASSWORD = "state-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://dev:devpw@localhost:5433/katana";
const SECRETS = [PASSWORD, "devpw", TEST_URL, DEV_URL, "postgresql://"];

const OTHER_KINDS = ["operator", "operator class", "cast", "trigger", "event trigger", "default privileges", "publication"];

const rel = (name: string, kind = "r", schema = "public", owner: string | null = null): CatalogRelation => ({
  schema,
  name,
  kind,
  ownerSchema: owner === null ? null : "public",
  ownerTable: owner,
});
const obj = (name: string, kind: string, schema = "public"): CatalogObject => ({ schema, name, kind });

/** migration 前の、完全に空のDB（public スキーマと plpgsql だけ） */
function emptyInventory(): CatalogInventory {
  return {
    schemas: ["public"],
    extensions: ["plpgsql"],
    relations: [],
    types: [],
    routines: [],
    otherObjects: OTHER_KINDS.map((kind) => ({ kind, count: 0 })),
  };
}

/** 8件の migration を適用した後のDB（15テーブル・_prisma_migrations・主キーのインデックス・enum） */
function migratedInventory(): CatalogInventory {
  const tables = [...TABLES, "_prisma_migrations"];
  return {
    ...emptyInventory(),
    relations: [...tables.map((name) => rel(name)), ...tables.map((name) => rel(`${name}_pkey`, "i", "public", name))],
    types: ENUMS.map((name) => obj(name, "e")),
  };
}

type FakeDb = {
  readOnly: string;
  /** set_config の戻り値（search_path の固定の結果） */
  searchPath: string;
  identity: Record<string, unknown>[];
  inventory: CatalogInventory;
  migrations: Record<string, unknown>[];
  nonEmpty: Set<string>;
  /** この正規表現に一致するSQLで、ドライバのエラーを投げる */
  failOn?: RegExp;
  failEnd?: boolean;
};

const finished = (name: string) => ({ name, finished: true, rolledBack: false });

function db(inventory: CatalogInventory = migratedInventory()): FakeDb {
  return {
    readOnly: "on",
    searchPath: "pg_catalog",
    identity: [
      { database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 },
    ],
    inventory,
    migrations: MIGRATIONS.map(finished),
    nonEmpty: new Set(),
  };
}

/** ドライバのエラーをまねる。メッセージに接続URL（パスワードを含む）を入れて、漏れないことを確かめる */
const driverError = (code = "XX000") => Object.assign(new Error(`driver error for ${TEST_URL}`), { code });

function fakeConnection(state: FakeDb) {
  const log: string[] = [];
  const statements: string[] = [];
  let ended = 0;
  const rowsOf = (statement: string): [string, Record<string, unknown>[]] => {
    const { inventory } = state;
    if (statement === "BEGIN READ ONLY") return ["BEGIN", []];
    if (statement === "ROLLBACK") return ["ROLLBACK", []];
    if (statement.includes("set_config('search_path'")) return ["PIN", [{ searchPath: state.searchPath }]];
    if (statement === "SHOW transaction_read_only") return ["SHOW", [{ transaction_read_only: state.readOnly }]];
    if (statement.includes("current_database()")) return ["IDENTITY", state.identity];
    if (statement.includes("pg_catalog.pg_operator")) return ["OTHER", inventory.otherObjects];
    if (statement.includes("pg_catalog.pg_type t")) return ["TYPES", inventory.types];
    if (statement.includes("pg_catalog.pg_proc p")) return ["ROUTINES", inventory.routines];
    if (statement.includes("pg_catalog.pg_extension")) return ["EXTENSIONS", inventory.extensions.map((name) => ({ name }))];
    if (statement.includes("pg_catalog.pg_class c")) return ["RELATIONS", inventory.relations];
    if (statement.includes("pg_catalog.pg_namespace n")) return ["SCHEMAS", inventory.schemas.map((name) => ({ name }))];
    if (statement.includes('"_prisma_migrations"')) return ["MIGRATIONS", state.migrations];
    const exists = /^SELECT EXISTS \(SELECT 1 FROM "public"\."([A-Za-z0-9_]+)"\)/.exec(statement);
    if (exists) return [`EXISTS ${exists[1]}`, [{ hasRows: state.nonEmpty.has(exists[1]) }]];
    throw new Error(`unexpected SQL in test: ${statement}`);
  };
  const client: IntegrationDbClient = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, " ").trim();
      statements.push(statement);
      const [label, rows] = rowsOf(statement);
      if (state.failOn?.test(statement)) {
        log.push(`FAIL ${label}`);
        throw driverError("42501");
      }
      log.push(label);
      return { rows };
    },
    async end() {
      ended += 1;
      if (state.failEnd) throw driverError("ECONNRESET");
    },
  };
  const connect = vi.fn(async (url: string) => {
    log.push(`CONNECT ${url === TEST_URL ? "test-url" : "other-url"}`);
    return client;
  });
  return { connect, log, statements, endedCount: () => ended };
}

function input(state: FakeDb, overrides: Partial<ClassifyTestDatabaseInput> = {}) {
  const connection = fakeConnection(state);
  const value: ClassifyTestDatabaseInput = {
    databaseUrl: TEST_URL,
    developmentDatabaseUrl: DEV_URL,
    expected: EXPECTED,
    connect: connection.connect,
    ...overrides,
  };
  return { value, ...connection };
}

async function failureOf(value: ClassifyTestDatabaseInput): Promise<Error> {
  try {
    await classifyTestDatabase(value);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the classification to fail");
}

function expectNoSecrets(textValue: string) {
  for (const secret of SECRETS) expect(textValue).not.toContain(secret);
}

/** 状態 B と判定され、理由に指定した文字列が含まれること */
async function expectStateB(state: FakeDb, reason: RegExp) {
  const { value, endedCount, log } = input(state);
  const result = await classifyTestDatabase(value);
  expect(result.state).toBe("B");
  const reasons = result.state === "B" ? result.reasons.join("\n") : "";
  expect(reasons).toMatch(reason);
  expectNoSecrets(reasons);
  expect(log.at(-1)).toBe("ROLLBACK");
  expect(endedCount()).toBe(1);
  return log;
}

describe("期待値（実際の schema.prisma・prisma/migrations）", () => {
  it("アプリのテーブル15件・enum 5件・migration 8件（件数は固定せず、ファイルから読む）", () => {
    expect(TABLES).toHaveLength(15);
    expect(ENUMS).toEqual(["ImportRowStatus", "ImportStatus", "ProductHistoryAction", "ProductStatus", "UserRole"]);
    expect(MIGRATIONS).toEqual([
      "20260118115533_init_new_schema",
      "20260506222715_add_katana_listing",
      "20260509020919_make_era_nullable",
      "20260718054301_init",
      "20260922030332_domain_model_province_swordera_import_seq",
      "20260924081921_product_price_optional",
      "20260924082945_product_maker_optional",
      "20261003010138_price_history_new_price_nullable",
    ]);
  });

  it.each([
    ["@@map", 'enum Role {\n  A\n  @@map("roles")\n}'],
    ["@map", 'enum Role {\n  A @map("a")\n}'],
  ])("enum の %s は拒否する", (_label, source) => {
    expect(() => enumNamesFromSchema(source)).toThrow(expect.objectContaining({ code: "SCHEMA_UNSUPPORTED" }));
  });
});

describe("classifyTestDatabase：本人確認", () => {
  it("本人確認に成功し、migration 前の完全に空のDBを A と判定する。SELECT だけを行い、ROLLBACK して接続を閉じる", async () => {
    const { value, log, connect, endedCount } = input(db(emptyInventory()));
    await expect(classifyTestDatabase(value)).resolves.toEqual({ state: "A" });
    expect(log).toEqual(["CONNECT test-url", "BEGIN", "PIN", "SHOW", "IDENTITY", "SCHEMAS", "EXTENSIONS", "RELATIONS", "TYPES", "ROUTINES", "OTHER", "ROLLBACK"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(endedCount()).toBe(1);
  });

  it.each([
    ["DB名が違う", { database: "katana" }, "DATABASE_MISMATCH"],
    ["current_user が違う", { currentUser: "postgres" }, "CURRENT_USER_MISMATCH"],
    ["session_user が違う", { sessionUser: "postgres" }, "SESSION_USER_MISMATCH"],
    ["DBのコメントが違う", { marker: "katana-dev-db" }, "MARKER_MISMATCH"],
    ["DBのコメントがない", { marker: null }, "MARKER_MISMATCH"],
  ])("%s場合は拒否し、状態の判定（カタログの読み取り）に進まない", async (_label, patch, code) => {
    const state = db(emptyInventory());
    state.identity = [{ ...state.identity[0], ...patch }];
    const { value, log, endedCount } = input(state);
    const error = await failureOf(value);
    expect(error).toMatchObject({ code });
    expect(log).toEqual(["CONNECT test-url", "BEGIN", "PIN", "SHOW", "IDENTITY", "ROLLBACK"]);
    expect(endedCount()).toBe(1);
    expect(error.message).not.toMatch(/postgres"|katana-dev-db|"katana"/);
  });

  it.each([["public, pg_catalog"], ['"$user", public'], [""]])(
    "search_path を pg_catalog に固定できなかった（戻り値 %j）場合は、本人確認の前に拒否する",
    async (searchPath) => {
      const { value, log, endedCount } = input({ ...db(emptyInventory()), searchPath });
      await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code: "SEARCH_PATH_NOT_PINNED" });
      expect(log).toEqual(["CONNECT test-url", "BEGIN", "PIN", "ROLLBACK"]);
      expect(endedCount()).toBe(1);
    },
  );

  it("search_path の固定は、トランザクションの中だけ有効な set_config で行う（SET 文・セッション全体の変更は使わない）", async () => {
    const { value, statements } = input(db(emptyInventory()));
    await classifyTestDatabase(value);
    expect(statements[1]).toBe(`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true) AS "searchPath"`);
  });

  it("search_path の固定の SQL が失敗したら、QUERY_FAILED で止まり、本人確認に進まない", async () => {
    const { value, log } = input({ ...db(emptyInventory()), failOn: /set_config/ });
    await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(log).not.toContain("IDENTITY");
  });

  it("検査の SQL は、テーブル・カタログをすべてスキーマで修飾し、外部の入力（URL など）を含まない", async () => {
    for (const state of [db(emptyInventory()), db()]) {
      const { value, statements } = input(state);
      await classifyTestDatabase(value);
      for (const sql of statements) {
        for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+(?!\()([^\s)]+)/g)) {
          expect(match[1]).toMatch(/^(pg_catalog\.pg_[a-z_]+|"public"\."[A-Za-z0-9_]+")$/);
        }
        expect(sql).not.toContain("127.0.0.1");
        expect(sql).not.toContain("katana_test_user:");
      }
    }
  });

  it("トランザクションが読み取り専用でない場合は拒否する", async () => {
    const { value, log } = input({ ...db(emptyInventory()), readOnly: "off" });
    await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code: "NOT_READ_ONLY" });
    expect(log).not.toContain("SCHEMAS");
  });

  it.each([
    ["開発用DBのURL", DEV_URL],
    ["ポートが違う", TEST_URL.replace("5434", "5433")],
    ["DB名が違う", TEST_URL.replace("/katana_test", "/katana")],
  ])("接続URLが%s場合は、接続する前に拒否する", async (_label, databaseUrl) => {
    const { value, connect } = input(db(), { databaseUrl });
    const error = await failureOf(value);
    expect(error).toMatchObject({ code: "TARGET_REJECTED" });
    expect(connect).not.toHaveBeenCalled();
    expectNoSecrets(error.message);
  });

  it.each([
    ["想定テーブルが空", { ...EXPECTED, tables: [] }, "SCHEMA_UNSUPPORTED"],
    ["想定 migration が空", { ...EXPECTED, migrations: [] }, "SCHEMA_UNSUPPORTED"],
    ["想定 migration が重複", { ...EXPECTED, migrations: [...MIGRATIONS, MIGRATIONS[0]] }, "SCHEMA_UNSUPPORTED"],
    ["_prisma_migrations をアプリのテーブルとして渡す", { ...EXPECTED, tables: [...TABLES, "_prisma_migrations"] }, "SCHEMA_UNSUPPORTED"],
    ["テーブル名に引用符", { ...EXPECTED, tables: ['Shop"; DROP TABLE "User'] }, "INVALID_IDENTIFIER"],
    ["enum 名に引用符", { ...EXPECTED, enums: ['Role"'] }, "INVALID_IDENTIFIER"],
  ])("期待値が不正（%s）な場合は、接続する前に拒否する", async (_label, expected, code) => {
    const { value, connect } = input(db(), { expected });
    await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("classifyTestDatabase：A（完全に空のDB）とその崩れ", () => {
  it.each<[string, (inv: CatalogInventory) => void, RegExp]>([
    ["enum だけがある", (inv) => inv.types.push(obj("UserRole", "e")), /types: public\.UserRole \(e\)/],
    ["シーケンスだけがある", (inv) => inv.relations.push(rel("Product_id_seq", "S")), /relations: public\.Product_id_seq \(S\)/],
    ["インデックスだけがある", (inv) => inv.relations.push(rel("orphan_idx", "i")), /orphan_idx \(i\)/],
    ["関数だけがある", (inv) => inv.routines.push(obj("touch_updated_at", "f")), /unexpected routines: public\.touch_updated_at \(f\)/],
    ["プロシージャだけがある", (inv) => inv.routines.push(obj("cleanup", "p")), /public\.cleanup \(p\)/],
    ["domain だけがある", (inv) => inv.types.push(obj("price_yen", "d")), /public\.price_yen \(d\)/],
    ["複合型だけがある", (inv) => inv.types.push(obj("money_pair", "c")), /public\.money_pair \(c\)/],
    ["range 型だけがある", (inv) => inv.types.push(obj("price_range", "r"), obj("price_multirange", "m")), /price_range \(r\)/],
    ["想定外のスキーマがある", (inv) => inv.schemas.push("archive"), /unexpected schemas: archive/],
    ["public スキーマがない", (inv) => (inv.schemas = []), /schema public is missing/],
    ["想定外の拡張がある", (inv) => inv.extensions.push("pgcrypto"), /unexpected extensions: pgcrypto/],
    ["ビューだけがある", (inv) => inv.relations.push(rel("market_view", "v")), /market_view \(v\)/],
    ["マテリアライズドビューだけがある", (inv) => inv.relations.push(rel("market_mv", "m")), /market_mv \(m\)/],
    ["外部テーブルだけがある", (inv) => inv.relations.push(rel("remote_products", "f")), /remote_products \(f\)/],
    ["アプリのテーブルだけがある（_prisma_migrations がない）", (inv) => inv.relations.push(rel("Shop")), /_prisma_migrations is missing/],
    ["別スキーマのテーブルがある", (inv) => inv.relations.push(rel("Product", "r", "archive")), /archive\.Product \(r\)/],
    [
      "その他のユーザー定義オブジェクト（演算子）がある",
      (inv) => (inv.otherObjects = inv.otherObjects.map((o) => (o.kind === "operator" ? { ...o, count: 2 } : o))),
      /unexpected objects: operator \(2\)/,
    ],
    [
      "アクセスメソッドがある",
      (inv) => inv.otherObjects.push({ kind: "access method", count: 1 }),
      /access method \(1\)/,
    ],
    [
      "イベントトリガーがある",
      (inv) => (inv.otherObjects = inv.otherObjects.map((o) => (o.kind === "event trigger" ? { ...o, count: 1 } : o))),
      /event trigger \(1\)/,
    ],
  ])("%s場合は B（migration を拒否）と判定する", async (_label, change, reason) => {
    const inventory = emptyInventory();
    change(inventory);
    const log = await expectStateB(db(inventory), reason);
    // C の候補でないので、migration の履歴も空DB検査も読まない
    expect(log).not.toContain("MIGRATIONS");
    expect(log.some((entry) => entry.startsWith("EXISTS"))).toBe(false);
  });

  it("plpgsql の拡張がなくても A と判定する（許可するだけで、必須ではない）", async () => {
    await expect(classifyTestDatabase(input(db({ ...emptyInventory(), extensions: [] })).value)).resolves.toEqual({ state: "A" });
  });

  it("件数として読めない値は、オブジェクトがあるものとして B にする", () => {
    const inventory = { ...emptyInventory(), otherObjects: [{ kind: "cast", count: Number.POSITIVE_INFINITY }] };
    expect(classifyCatalogInventory(inventory, EXPECTED)).toMatchObject({
      state: "B",
      reasons: expect.arrayContaining([expect.stringMatching(/cast \(unknown count\)/)]),
    });
  });
});

describe("classifyTestDatabase：C（全件適用済み）", () => {
  it("全8件の migration と15テーブルが正常で、データがなければ C と判定する（migrate diff は未実施）", async () => {
    const { value, log, endedCount } = input(db());
    await expect(classifyTestDatabase(value)).resolves.toEqual({
      state: "C",
      tables: TABLES,
      migrations: MIGRATIONS,
      schemaDiff: "not-verified",
    });
    expect(log.slice(0, 12)).toEqual(["CONNECT test-url", "BEGIN", "PIN", "SHOW", "IDENTITY", "SCHEMAS", "EXTENSIONS", "RELATIONS", "TYPES", "ROUTINES", "OTHER", "MIGRATIONS"]);
    expect(log.filter((entry) => entry.startsWith("EXISTS"))).toEqual(TABLES.map((name) => `EXISTS ${name}`));
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(endedCount()).toBe(1);
  });

  it("想定テーブルが所有するシーケンス（SERIAL・IDENTITY）は許可する", async () => {
    const inventory = migratedInventory();
    inventory.relations.push(rel("ImportJob_seq_seq", "S", "public", "ImportJob"));
    await expect(classifyTestDatabase(input(db(inventory)).value)).resolves.toMatchObject({ state: "C" });
  });
});

describe("classifyTestDatabase：B（部分適用・失敗・不整合）", () => {
  it.each<[string, (rows: Record<string, unknown>[]) => Record<string, unknown>[], RegExp]>([
    ["1件だけ適用済み", (rows) => rows.slice(0, 1), /missing: 7/],
    ["3件だけ適用済み", (rows) => rows.slice(0, 3), /missing: 5/],
    ["失敗（未完了）の記録がある", (rows) => [...rows.slice(0, 7), { name: MIGRATIONS[7], finished: false, rolledBack: false }], /failed or rolled back: 1/],
    ["ロールバックの記録がある", (rows) => [...rows, { name: MIGRATIONS[0], finished: true, rolledBack: true }], /failed or rolled back: 1/],
    ["重複した記録がある", (rows) => [...rows, rows[0]], /duplicated: yes/],
    ["想定外の migration がある", (rows) => [...rows, finished("20270101000000_future")], /unexpected migrations: 20270101000000_future/],
    ["履歴が空", () => [], /missing: 8/],
  ])("migration の履歴が%s場合は B と判定し、空DB検査に進まない", async (_label, change, reason) => {
    const state = db();
    state.migrations = change(state.migrations);
    const log = await expectStateB(state, reason);
    expect(log.some((entry) => entry.startsWith("EXISTS"))).toBe(false);
  });

  it.each<[string, (inv: CatalogInventory) => void, RegExp]>([
    ["_prisma_migrations だけがある", (inv) => (inv.relations = [rel("_prisma_migrations"), rel("_prisma_migrations_pkey", "i", "public", "_prisma_migrations")]), /missing tables: .*Shop/],
    ["履歴はあるがテーブルが不足する", (inv) => (inv.relations = inv.relations.filter((r) => r.name !== "Shop")), /missing tables: Shop$/m],
    ["想定外のテーブルがある", (inv) => inv.relations.push(rel("Katana")), /unexpected relations: public\.Katana \(r\)/],
    ["暗黙の多対多のテーブルがある", (inv) => inv.relations.push(rel("_ProductToShop")), /_ProductToShop \(r\)/],
    ["ビューがある", (inv) => inv.relations.push(rel("market_view", "v")), /market_view \(v\)/],
    ["想定テーブルと同じ名前のビュー", (inv) => (inv.relations = inv.relations.map((r) => (r.name === "Shop" ? { ...r, kind: "v" } : r))), /missing tables: Shop[\s\S]*public\.Shop \(v\)/],
    ["パーティションテーブルがある", (inv) => inv.relations.push(rel("ProductArchive", "p")), /ProductArchive \(p\)/],
    ["想定外のテーブルのインデックスがある", (inv) => inv.relations.push(rel("Katana_pkey", "i", "public", "Katana")), /Katana_pkey \(i\)/],
    ["所有者のないシーケンスがある", (inv) => inv.relations.push(rel("orphan_seq", "S")), /orphan_seq \(S\)/],
    ["enum が足りない", (inv) => (inv.types = inv.types.filter((t) => t.name !== "UserRole")), /missing enums: UserRole/],
    ["想定外の enum がある（削除済みの Era）", (inv) => inv.types.push(obj("Era", "e")), /unexpected types: public\.Era \(e\)/],
    ["domain がある", (inv) => inv.types.push(obj("price_yen", "d")), /price_yen \(d\)/],
    ["関数がある", (inv) => inv.routines.push(obj("touch_updated_at", "f")), /unexpected routines/],
    ["想定外のスキーマがある", (inv) => inv.schemas.push("archive"), /unexpected schemas: archive/],
    ["想定外の拡張がある", (inv) => inv.extensions.push("pg_trgm"), /unexpected extensions: pg_trgm/],
    [
      "ユーザー定義のトリガーがある",
      (inv) => (inv.otherObjects = inv.otherObjects.map((o) => (o.kind === "trigger" ? { ...o, count: 1 } : o))),
      /unexpected objects: trigger \(1\)/,
    ],
  ])("%s場合は B と判定し、migration の履歴も空DB検査も読まない", async (_label, change, reason) => {
    const inventory = migratedInventory();
    change(inventory);
    const log = await expectStateB(db(inventory), reason);
    expect(log).not.toContain("MIGRATIONS");
    expect(log.some((entry) => entry.startsWith("EXISTS"))).toBe(false);
  });

  it("アプリのテーブルにデータがあれば C と判定せず B にし、そのテーブル名を示す", async () => {
    const state = { ...db(), nonEmpty: new Set(["Shop"]) };
    const log = await expectStateB(state, /tables are not empty: Shop$/);
    expect(log.filter((entry) => entry.startsWith("EXISTS"))).toHaveLength(TABLES.length);
  });

  it("判定の理由は、多すぎるときは件数だけを示す", () => {
    const inventory = emptyInventory();
    inventory.relations = Array.from({ length: 25 }, (_, i) => rel(`t${String(i).padStart(2, "0")}`));
    const result = classifyCatalogInventory(inventory, EXPECTED);
    expect(result).toMatchObject({ state: "B" });
    expect(result.state === "B" && result.reasons.find((r) => r.startsWith("relations:"))).toMatch(/\(and 5 more\)$/);
  });
});

describe("classifyTestDatabase：検査の失敗（fail-closed）と接続の解放", () => {
  it.each([
    ["スキーマの一覧", /pg_catalog\.pg_namespace n WHERE/],
    ["拡張の一覧", /pg_extension/],
    ["リレーションの一覧", /pg_catalog\.pg_class c/],
    ["型の一覧", /pg_catalog\.pg_type t/],
    ["関数の一覧", /pg_catalog\.pg_proc p/],
    ["その他のオブジェクトの一覧", /pg_operator/],
    ["migration の履歴", /"_prisma_migrations"/],
    ["空DB検査", /SELECT EXISTS/],
    ["本人確認", /current_database\(\)/],
    ["search_path の固定", /set_config/],
  ])("%sのSQLが失敗したら、B と断定せずに QUERY_FAILED で止め、ROLLBACK して接続を閉じる", async (_label, failOn) => {
    const { value, log, endedCount } = input({ ...db(), failOn });
    const error = await failureOf(value);
    expect(error).toMatchObject({ code: "QUERY_FAILED" });
    expect(error.message).toContain("42501");
    expectNoSecrets(error.message);
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(endedCount()).toBe(1);
  });

  it("BEGIN READ ONLY が失敗したら、ROLLBACK せずに接続を閉じる", async () => {
    const { value, log, endedCount } = input({ ...db(), failOn: /^BEGIN/ });
    await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(log).not.toContain("ROLLBACK");
    expect(endedCount()).toBe(1);
  });

  it("ROLLBACK が失敗しても接続を閉じ、拒否する", async () => {
    const { value, endedCount } = input({ ...db(), failOn: /^ROLLBACK$/ });
    await expect(classifyTestDatabase(value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(endedCount()).toBe(1);
  });

  it("判定の後に接続を閉じられなければ、状態を返さずに拒否する", async () => {
    const error = await failureOf(input({ ...db(), failEnd: true }).value);
    expect(error).toMatchObject({ code: "CLOSE_FAILED" });
    expectNoSecrets(error.message);
  });

  it("検査の失敗と接続を閉じる失敗が重なったら、検査の失敗を投げる", async () => {
    const state = { ...db(), failEnd: true, failOn: /pg_catalog\.pg_type t/ };
    await expect(classifyTestDatabase(input(state).value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("接続に失敗したら拒否し、別の接続先を試さない。ドライバのメッセージ（URL）を含めない", async () => {
    const connect = vi.fn(async () => {
      throw driverError("ECONNREFUSED");
    });
    const error = await failureOf({ ...input(db()).value, connect });
    expect(error).toMatchObject({ code: "CONNECT_FAILED" });
    expect(error.message).toContain("ECONNREFUSED");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(TEST_URL);
    expectNoSecrets(error.message);
  });

  it("その他のオブジェクトは、正常なDBに OID 16384 以上の行が現れないカタログだけを OID で数える", async () => {
    const { value, statements } = input(db(emptyInventory()));
    await classifyTestDatabase(value);
    const other = statements.find((sql) => sql.includes("pg_catalog.pg_operator")) ?? "";
    const parts = other.split(" UNION ALL ");
    const catalogs = parts.map((part) => /FROM (pg_catalog\.[a-z_]+)/.exec(part)?.[1]);
    expect(catalogs).toEqual([
      "pg_catalog.pg_operator",
      "pg_catalog.pg_opclass",
      "pg_catalog.pg_opfamily",
      "pg_catalog.pg_collation",
      "pg_catalog.pg_conversion",
      "pg_catalog.pg_cast",
      "pg_catalog.pg_language",
      "pg_catalog.pg_ts_config",
      "pg_catalog.pg_ts_dict",
      "pg_catalog.pg_ts_parser",
      "pg_catalog.pg_ts_template",
      "pg_catalog.pg_statistic_ext",
      "pg_catalog.pg_rewrite",
      "pg_catalog.pg_trigger",
      "pg_catalog.pg_policy",
      "pg_catalog.pg_event_trigger",
      "pg_catalog.pg_publication",
      "pg_catalog.pg_foreign_data_wrapper",
      "pg_catalog.pg_foreign_server",
      "pg_catalog.pg_default_acl",
      "pg_catalog.pg_largeobject_metadata",
      "pg_catalog.pg_am",
      "pg_catalog.pg_transform",
    ]);
    for (const part of parts) expect(part).toMatch(/ WHERE oid >= 16384( AND NOT tgisinternal)?$/);
    // 外部キーの内部トリガーは C で正常に存在するので、トリガーだけは内部のものを除く
    expect(parts.filter((part) => part.includes("tgisinternal"))).toEqual([expect.stringContaining("pg_catalog.pg_trigger")]);
    // 正常なDBでも OID 16384 以上の行があるカタログ（テーブル・enum に付随するもの、クラスタ共通のもの）は、OID で数えない
    for (const catalog of ["pg_class", "pg_type", "pg_proc", "pg_namespace", "pg_constraint", "pg_attrdef", "pg_enum", "pg_depend", "pg_index", "pg_database", "pg_authid", "pg_shdescription", "pg_description"]) {
      expect(other).not.toContain(`pg_catalog.${catalog} `);
    }
  });

  it("リレーション・型・関数の一覧は、OID ではなくシステム以外のスキーマで絞り込む", async () => {
    const { value, statements } = input(db(emptyInventory()));
    await classifyTestDatabase(value);
    for (const marker of ["pg_catalog.pg_class c", "pg_catalog.pg_type t", "pg_catalog.pg_proc p", "FROM pg_catalog.pg_namespace n WHERE"]) {
      const sql = statements.find((statement) => statement.includes(marker)) ?? "";
      expect(sql).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'");
      expect(sql).not.toContain("16384");
    }
    // シーケンスの所有者は pg_depend の自動（a）・内部（i）の依存だけで判定し、行型と配列型は二重に数えない
    const relations = statements.find((statement) => statement.includes("pg_catalog.pg_class c")) ?? "";
    expect(relations).toContain("d.deptype IN ('a', 'i')");
    expect(relations).toContain("WHERE c.relkind <> 'c'");
    const types = statements.find((statement) => statement.includes("pg_catalog.pg_type t")) ?? "";
    expect(types).toContain("r.relkind <> 'c'");
    expect(types).toContain("e.typarray = t.oid");
  });

  it("実行するSQLは SELECT・SHOW・BEGIN READ ONLY・ROLLBACK だけで、DBを変更する文を含まない", async () => {
    for (const state of [db(emptyInventory()), db(), { ...db(), nonEmpty: new Set(["Shop"]) }]) {
      const { value, statements } = input(state);
      await classifyTestDatabase(value);
      expect(statements.length).toBeGreaterThan(0);
      for (const sql of statements) {
        expect(sql).toMatch(/^(SELECT|SHOW|BEGIN READ ONLY$|ROLLBACK$)/);
        expect(sql).not.toMatch(/\b(TRUNCATE|DELETE|DROP|CREATE|ALTER|INSERT|UPDATE|GRANT|REVOKE|COMMENT|SET|COPY|LOCK|VACUUM|CALL|DO)\b/i);
        expect(sql).not.toContain(";");
      }
    }
  });
});
