import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applicationTablesFromSchema,
  type IntegrationDatabaseCheckInput,
  type IntegrationDbClient,
  listMigrationNames,
  quoteIdentifier,
  TEST_DATABASE_MARKER,
  verifyIntegrationDatabase,
} from "./integrationDatabaseCheck";

// DBには接続しない。接続はインメモリの偽のクライアントで置き換える（pg・Prisma Client は読み込まない）
const ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "s3cret-pw";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_ENV = { DATABASE_URL: "postgresql://dev:devpw@localhost:5433/katana" };
const RUNNER_ENV = { DATABASE_URL: TEST_URL, KATANA_DB_TEST_MODE: "integration", KATANA_TEST_RUNNER: "script" };
const TABLES = ["Product", "Shop"];
const MIGRATIONS = ["20260101000000_a", "20260102000000_b"];

type FakeDb = {
  readOnly: string;
  identity: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  migrations: Record<string, unknown>[];
  nonEmpty: Set<string>;
  /** この正規表現に一致するSQLで、ドライバのエラーを投げる */
  failOn?: RegExp;
  failCode?: string;
  failEnd?: boolean;
};

const table = (name: string, schema = "public", kind = "r") => ({ schema, name, kind });

function healthyDb(): FakeDb {
  return {
    readOnly: "on",
    identity: [
      { database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 },
    ],
    relations: [...TABLES, "_prisma_migrations"].map((name) => table(name)),
    migrations: MIGRATIONS.map((name) => ({ name, finished: true, rolledBack: false })),
    nonEmpty: new Set(),
  };
}

/** ドライバのエラーをまねる。メッセージに接続URL（パスワードを含む）を入れて、漏れないことを確かめる */
const driverError = (code = "XX000") => Object.assign(new Error(`driver error for ${TEST_URL}`), { code });

function fakeConnection(db: FakeDb) {
  const log: string[] = [];
  let ended = 0;
  const client: IntegrationDbClient = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, " ").trim();
      if (db.failOn?.test(statement)) {
        log.push(`FAIL ${statement.slice(0, 40)}`);
        throw driverError(db.failCode);
      }
      if (statement === "BEGIN READ ONLY") return (log.push("BEGIN"), { rows: [] });
      if (statement === "ROLLBACK") return (log.push("ROLLBACK"), { rows: [] });
      if (statement === "SHOW transaction_read_only") return (log.push("SHOW"), { rows: [{ transaction_read_only: db.readOnly }] });
      if (statement.includes("current_database()")) return (log.push("IDENTITY"), { rows: db.identity });
      if (statement.includes("pg_catalog.pg_class")) return (log.push("RELATIONS"), { rows: db.relations });
      if (statement.includes('"_prisma_migrations"')) return (log.push("MIGRATIONS"), { rows: db.migrations });
      const exists = /^SELECT EXISTS \(SELECT 1 FROM "public"\."([A-Za-z0-9_]+)"\)/.exec(statement);
      if (exists) return (log.push(`EXISTS ${exists[1]}`), { rows: [{ hasRows: db.nonEmpty.has(exists[1]) }] });
      throw new Error(`unexpected SQL in test: ${statement}`);
    },
    async end() {
      ended += 1;
      if (db.failEnd) throw driverError("ECONNRESET");
    },
  };
  const connect = vi.fn(async (url: string) => {
    log.push(`CONNECT ${url === TEST_URL ? "test-url" : "other-url"}`);
    return client;
  });
  return { connect, log, endedCount: () => ended };
}

function input(db: FakeDb, overrides: Partial<IntegrationDatabaseCheckInput> = {}) {
  const connection = fakeConnection(db);
  const value: IntegrationDatabaseCheckInput = {
    env: RUNNER_ENV,
    developmentEnv: DEV_ENV,
    expectedTables: TABLES,
    expectedMigrations: MIGRATIONS,
    connect: connection.connect,
    ...overrides,
  };
  return { value, ...connection };
}

/** 失敗したときのエラーを返す（成功したらテストを失敗させる） */
async function failureOf(value: IntegrationDatabaseCheckInput): Promise<Error> {
  try {
    await verifyIntegrationDatabase(value);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the verification to fail");
}

function expectNoSecrets(error: Error) {
  expect(error.message).not.toContain(PASSWORD);
  expect(error.message).not.toContain("postgresql://");
  expect(error.message).not.toContain("devpw");
}

describe("verifyIntegrationDatabase：成功", () => {
  it("本人確認・テーブル構成・migration・空DB検査の順にSELECTだけを行い、ROLLBACKして接続を閉じる", async () => {
    const { value, log, connect, endedCount } = input(healthyDb());
    await expect(verifyIntegrationDatabase(value)).resolves.toEqual({
      database: "katana_test",
      user: "katana_test_user",
      serverPort: 5432,
      tables: ["Product", "Shop"],
      migrations: 2,
    });
    expect(log).toEqual([
      "CONNECT test-url",
      "BEGIN",
      "SHOW",
      "IDENTITY",
      "RELATIONS",
      "MIGRATIONS",
      "EXISTS Product",
      "EXISTS Shop",
      "ROLLBACK",
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(endedCount()).toBe(1);
  });

  it("サーバー内部のポートは判定に使わない（5432でも5434でも、取得できなくても成功する）", async () => {
    for (const serverPort of [5432, 5434, null]) {
      const db = healthyDb();
      db.identity = [{ ...db.identity[0], serverPort }];
      await expect(verifyIntegrationDatabase(input(db).value)).resolves.toMatchObject({ serverPort });
    }
  });
});

describe("verifyIntegrationDatabase：接続後の本人確認", () => {
  it.each([
    ["DB名が違う", { database: "katana" }, "DATABASE_MISMATCH"],
    ["current_user が違う", { currentUser: "postgres" }, "CURRENT_USER_MISMATCH"],
    ["session_user が違う（SET ROLE で current_user だけ合わせた）", { sessionUser: "postgres" }, "SESSION_USER_MISMATCH"],
    ["DBのコメントがない", { marker: null }, "MARKER_MISMATCH"],
    ["DBのコメントが違う", { marker: "katana-dev-db" }, "MARKER_MISMATCH"],
  ])("%s場合は拒否し、テーブルの検査に進まない", async (_label, patch, code) => {
    const db = healthyDb();
    db.identity = [{ ...db.identity[0], ...patch }];
    const { value, log, endedCount } = input(db);
    const error = await failureOf(value);
    expect(error).toMatchObject({ code });
    expect(log).toEqual(["CONNECT test-url", "BEGIN", "SHOW", "IDENTITY", "ROLLBACK"]);
    expect(endedCount()).toBe(1);
    // 実際の値は表示しない
    expect(error.message).not.toMatch(/postgres"|katana-dev-db|"katana"/);
  });

  it("DBの情報を取得できない（0行）場合は拒否する", async () => {
    const db = healthyDb();
    db.identity = [];
    await expect(verifyIntegrationDatabase(input(db).value)).rejects.toMatchObject({ code: "IDENTITY_UNAVAILABLE" });
  });

  it("DBの情報を取得するSQLが失敗した場合は拒否する", async () => {
    const db = { ...healthyDb(), failOn: /current_database\(\)/, failCode: "42501" };
    const { value, log, endedCount } = input(db);
    const error = await failureOf(value);
    expect(error).toMatchObject({ code: "QUERY_FAILED" });
    expect(error.message).toContain("42501");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(endedCount()).toBe(1);
  });

  it("トランザクションが読み取り専用でない場合は拒否する", async () => {
    const db = { ...healthyDb(), readOnly: "off" };
    const { value, log } = input(db);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code: "NOT_READ_ONLY" });
    expect(log).not.toContain("IDENTITY");
  });

  it("BEGIN READ ONLY が失敗した場合は拒否し、ROLLBACKせずに接続を閉じる", async () => {
    const db = { ...healthyDb(), failOn: /^BEGIN/ };
    const { value, log, endedCount } = input(db);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(log).not.toContain("ROLLBACK");
    expect(endedCount()).toBe(1);
  });
});

describe("verifyIntegrationDatabase：テーブル構成とmigration", () => {
  it("アプリケーションのテーブルが不足する場合は拒否する", async () => {
    const db = healthyDb();
    db.relations = db.relations.filter((row) => row.name !== "Shop");
    const error = await failureOf(input(db).value);
    expect(error).toMatchObject({ code: "TABLES_MISSING" });
    expect(error.message).toContain("Shop");
  });

  it("_prisma_migrations がない場合は拒否する", async () => {
    const db = healthyDb();
    db.relations = db.relations.filter((row) => row.name !== "_prisma_migrations");
    await expect(verifyIntegrationDatabase(input(db).value)).rejects.toMatchObject({ code: "TABLES_MISSING" });
  });

  it.each([
    ["public に想定外のテーブル", table("Katana")],
    ["暗黙の多対多のテーブル", table("_ProductToShop")],
    ["public のビュー", table("market_view", "public", "v")],
    ["マテリアライズドビュー", table("market_mv", "public", "m")],
    ["別スキーマのテーブル", table("Product", "archive")],
  ])("%sがある場合は拒否し、空DB検査に進まない", async (_label, extra) => {
    const db = healthyDb();
    db.relations = [...db.relations, extra];
    const { value, log } = input(db);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code: "UNEXPECTED_RELATIONS" });
    expect(log.some((entry) => entry.startsWith("EXISTS"))).toBe(false);
  });

  it("想定テーブルと同じ名前でも、テーブル以外（ビュー）なら拒否する", async () => {
    const db = healthyDb();
    db.relations = db.relations.map((row) => (row.name === "Shop" ? { ...row, kind: "v" } : row));
    await expect(verifyIntegrationDatabase(input(db).value)).rejects.toMatchObject({ code: "TABLES_MISSING" });
  });

  it.each([
    ["不足している", (rows: Record<string, unknown>[]) => rows.slice(1)],
    ["余分にある", (rows: Record<string, unknown>[]) => [...rows, { name: "20260103000000_c", finished: true, rolledBack: false }]],
    ["失敗・未完了のものがある", (rows: Record<string, unknown>[]) => [...rows, { name: "20260103000000_c", finished: false, rolledBack: false }]],
    ["ロールバックされたものがある", (rows: Record<string, unknown>[]) => [...rows, { name: MIGRATIONS[0], finished: true, rolledBack: true }]],
    ["同じものが重複している", (rows: Record<string, unknown>[]) => [...rows, rows[0]]],
  ])("migrationが%s場合は拒否する", async (_label, change) => {
    const db = healthyDb();
    db.migrations = change(db.migrations);
    const { value, log } = input(db);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code: "MIGRATIONS_MISMATCH" });
    expect(log.some((entry) => entry.startsWith("EXISTS"))).toBe(false);
  });
});

describe("verifyIntegrationDatabase：空DB検査", () => {
  it("1テーブルでもデータがあれば拒否し、そのテーブル名を示す", async () => {
    const db = { ...healthyDb(), nonEmpty: new Set(["Shop"]) };
    const { value, log, endedCount } = input(db);
    const error = await failureOf(value);
    expect(error).toMatchObject({ code: "DATA_PRESENT" });
    expect(error.message).toContain("Shop");
    expect(error.message).not.toContain("Product");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(endedCount()).toBe(1);
  });

  it("空DB検査のSQLが失敗した場合（権限不足など）は拒否する", async () => {
    const db = { ...healthyDb(), failOn: /FROM "public"\."Product"/, failCode: "42501" };
    const error = await failureOf(input(db).value);
    expect(error).toMatchObject({ code: "QUERY_FAILED" });
    expect(error.message).toContain("42501");
  });

  it("検査で実行するSQLは SELECT・SHOW・BEGIN READ ONLY・ROLLBACK だけ", async () => {
    const statements: string[] = [];
    const db = healthyDb();
    const { value } = input(db);
    const connect = async (url: string) => {
      const client = await value.connect(url);
      return {
        query: (sql: string, params?: readonly unknown[]) => (statements.push(sql.trim()), client.query(sql, params)),
        end: () => client.end(),
      };
    };
    await verifyIntegrationDatabase({ ...value, connect });
    for (const sql of statements) {
      expect(sql).toMatch(/^(SELECT|SHOW|BEGIN READ ONLY$|ROLLBACK$)/);
      expect(sql).not.toMatch(/\b(TRUNCATE|DELETE|DROP|CREATE|ALTER|INSERT|UPDATE|GRANT)\b/i);
    }
  });
});

describe("verifyIntegrationDatabase：接続と停止", () => {
  it("接続に失敗した場合は拒否し、別の接続先を試さない", async () => {
    const connect = vi.fn(async () => {
      throw driverError("ECONNREFUSED");
    });
    const error = await failureOf({ ...input(healthyDb()).value, connect });
    expect(error).toMatchObject({ code: "CONNECT_FAILED" });
    expect(error.message).toContain("ECONNREFUSED");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(TEST_URL);
    expectNoSecrets(error);
  });

  it.each([
    ["runner を経由しない", { DATABASE_URL: TEST_URL }],
    ["統合テストのモードでない", { ...RUNNER_ENV, KATANA_DB_TEST_MODE: "unit" }],
    ["開発用DBのURL", { ...RUNNER_ENV, DATABASE_URL: DEV_ENV.DATABASE_URL }],
    ["DATABASE_URL がない", { KATANA_DB_TEST_MODE: "integration", KATANA_TEST_RUNNER: "script" }],
    ["PG* が設定されている", { ...RUNNER_ENV, PGHOST: "elsewhere" }],
  ])("%s場合は、接続する前に停止する", async (_label, env) => {
    const { value, connect } = input(healthyDb(), { env });
    const error = await failureOf(value);
    expect(connect).not.toHaveBeenCalled();
    expectNoSecrets(error);
  });

  it.each([
    ["想定テーブルが空", { expectedTables: [] }, "SCHEMA_UNSUPPORTED"],
    ["想定migrationが空", { expectedMigrations: [] }, "SCHEMA_UNSUPPORTED"],
    ["_prisma_migrations をアプリケーションのテーブルとして渡す", { expectedTables: ["Shop", "_prisma_migrations"] }, "SCHEMA_UNSUPPORTED"],
    ["テーブル名に引用符を含む", { expectedTables: ['Shop"; DROP TABLE "User'] }, "INVALID_IDENTIFIER"],
  ])("%s場合は、接続する前に停止する", async (_label, overrides, code) => {
    const { value, connect } = input(healthyDb(), overrides);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code });
    expect(connect).not.toHaveBeenCalled();
  });

  it("検査に失敗したら、後続の処理（テストの開始）に進まない", async () => {
    const startTests = vi.fn();
    const db = { ...healthyDb(), nonEmpty: new Set(["Product"]) };
    await verifyIntegrationDatabase(input(db).value).then(startTests, () => undefined);
    expect(startTests).not.toHaveBeenCalled();

    await verifyIntegrationDatabase(input(healthyDb()).value).then(startTests, () => undefined);
    expect(startTests).toHaveBeenCalledTimes(1);
  });

  it("成功した後に接続を閉じられなければ拒否する", async () => {
    const db = { ...healthyDb(), failEnd: true };
    await expect(verifyIntegrationDatabase(input(db).value)).rejects.toMatchObject({ code: "CLOSE_FAILED" });
  });

  it("検査の失敗と接続を閉じる失敗が重なったら、検査の失敗を投げる", async () => {
    const db = { ...healthyDb(), failEnd: true, nonEmpty: new Set(["Shop"]) };
    await expect(verifyIntegrationDatabase(input(db).value)).rejects.toMatchObject({ code: "DATA_PRESENT" });
  });

  it("ROLLBACK に失敗しても接続を閉じ、拒否する", async () => {
    const db = { ...healthyDb(), failOn: /^ROLLBACK$/ };
    const { value, endedCount } = input(db);
    await expect(verifyIntegrationDatabase(value)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(endedCount()).toBe(1);
  });

  it("ドライバのエラーメッセージ（接続URLを含む）を例外に含めない", async () => {
    for (const failOn of [/^BEGIN/, /^SHOW/, /current_database/, /pg_class/, /_prisma_migrations/, /SELECT EXISTS/, /^ROLLBACK$/]) {
      const error = await failureOf(input({ ...healthyDb(), failOn }).value);
      expect(error).toMatchObject({ code: "QUERY_FAILED" });
      expectNoSecrets(error);
    }
    expectNoSecrets(await failureOf(input({ ...healthyDb(), failEnd: true }).value));
  });
});

describe("期待値の取得（ファイルを読むだけ）", () => {
  it("schema.prisma のモデル15件を実テーブル名として返す（@map・@@map がない）", () => {
    const tables = applicationTablesFromSchema(readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8"));
    expect(tables).toEqual(
      [
        "Appraiser",
        "Category",
        "Grade",
        "ImportJob",
        "ImportRow",
        "Maker",
        "Period",
        "PriceHistory",
        "Product",
        "ProductHistory",
        "Province",
        "Rank",
        "Shop",
        "SwordEra",
        "User",
      ].sort(),
    );
  });

  it.each([
    ["@@map", 'model Shop {\n  id String @id\n  @@map("shops")\n}'],
    ["@map", 'model Shop {\n  id String @id @map("shop_id")\n}'],
    ["@@schema", 'model Shop {\n  id String @id\n  @@schema("app")\n}'],
    ["モデルなし", "enum Role {\n  A\n}"],
  ])("%s は対応関係を正しく扱えないので拒否する", (_label, source) => {
    expect(() => applicationTablesFromSchema(source)).toThrow(expect.objectContaining({ code: "SCHEMA_UNSUPPORTED" }));
  });

  it("prisma/migrations の8件を返す", () => {
    expect(listMigrationNames(path.join(ROOT, "prisma/migrations"))).toHaveLength(8);
  });

  it.each(['Shop"', "Shop; DROP TABLE x", "public.Shop", "", "1Shop", "ショップ"])("識別子 %j は拒否する", (name) => {
    expect(() => quoteIdentifier(name)).toThrow(expect.objectContaining({ code: "INVALID_IDENTIFIER" }));
  });
});
