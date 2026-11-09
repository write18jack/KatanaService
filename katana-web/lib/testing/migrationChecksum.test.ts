import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IntegrationDatabaseCheckError, type IntegrationDbClient, listMigrationNames, TEST_DATABASE_MARKER } from "./integrationDatabaseCheck";
import {
  assertMigrationChecksums,
  compareMigrationChecksums,
  computeMigrationChecksum,
  inspectMigrationChecksums,
  type LocalMigrationChecksum,
  MIGRATION_CHECKSUM_SQL,
  MigrationChecksumError,
  type MigrationChecksumErrorCode,
  type MigrationDirent,
  type MigrationFs,
  readLocalMigrationChecksums,
} from "./migrationChecksum";

// DB にも Docker にも接続しない。ファイルシステムは偽のもの（読み取りだけ）か、リポジトリの prisma/migrations の読み取りだけを使う
const REPO_ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "checksum-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";
const SECRETS = [PASSWORD, "dev-dummy-pass", TEST_URL, DEV_URL, "postgresql://"];
const DIR = "/repo/prisma/migrations";
const M1 = "20260101000000_first";
const M2 = "20260102000000_second";
const M3 = "20260103000000_third";
const bytes = (text: string) => new TextEncoder().encode(text);
const SQL = { [M1]: "CREATE TABLE a ();\n", [M2]: "ALTER TABLE a ADD COLUMN b int;\n", [M3]: "DROP TABLE a;\n" };

type FakeNode = { kind: "dir" } | { kind: "file"; content: Uint8Array } | { kind: "symlink" };

/** 偽のファイルシステム。読み取りの操作だけを持ち、呼ばれた操作を記録する */
function fakeFs(
  overrides: { nodes?: Record<string, FakeNode | undefined>; realpaths?: Record<string, string>; readErrors?: Record<string, string> } = {},
): MigrationFs & { calls: string[] } {
  const base: Record<string, FakeNode | undefined> = {
    [DIR]: { kind: "dir" },
    [`${DIR}/migration_lock.toml`]: { kind: "file", content: bytes('provider = "postgresql"\n') },
  };
  for (const [name, sql] of Object.entries(SQL)) {
    base[`${DIR}/${name}`] = { kind: "dir" };
    base[`${DIR}/${name}/migration.sql`] = { kind: "file", content: bytes(sql) };
  }
  const nodes = { ...base, ...overrides.nodes };
  const calls: string[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p} ${TEST_URL}`), { code: "ENOENT" });
  const statOf = (node: FakeNode) => ({
    isDirectory: () => node.kind === "dir",
    isFile: () => node.kind === "file",
    isSymbolicLink: () => node.kind === "symlink",
  });
  return {
    calls,
    lstat: (p) => {
      calls.push(`lstat:${p}`);
      const node = nodes[p];
      if (!node) throw enoent(p);
      return statOf(node);
    },
    readdir: (p) => {
      calls.push(`readdir:${p}`);
      if (nodes[p]?.kind !== "dir") throw enoent(p);
      return Object.entries(nodes)
        .filter((entry): entry is [string, FakeNode] => entry[1] !== undefined && path.posix.dirname(entry[0]) === p && entry[0] !== p)
        .map(([full, node]): MigrationDirent => ({ name: path.posix.basename(full), ...statOf(node) }));
    },
    realpath: (p) => {
      calls.push(`realpath:${p}`);
      if (!nodes[p]) throw enoent(p);
      return overrides.realpaths?.[p] ?? p;
    },
    readFile: (p) => {
      calls.push(`readFile:${p}`);
      const code = overrides.readErrors?.[p];
      if (code) throw Object.assign(new Error(`${code}: open ${p} (secret ${PASSWORD})`), { code });
      const node = nodes[p];
      if (node?.kind !== "file") throw enoent(p);
      return node.content;
    },
  };
}

function expectChecksumError(f: () => unknown, code: MigrationChecksumErrorCode): MigrationChecksumError {
  let caught: unknown;
  try {
    f();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationChecksumError);
  expect((caught as MigrationChecksumError).code).toBe(code);
  for (const secret of SECRETS) expect((caught as Error).message).not.toContain(secret);
  return caught as MigrationChecksumError;
}

const LOCAL: LocalMigrationChecksum[] = Object.entries(SQL).map(([name, sql]) => ({ name, checksum: computeMigrationChecksum(bytes(sql)) }));
const goodRows = () => LOCAL.map((m) => ({ name: m.name, checksum: m.checksum, finished: true, rolledBack: false }));

describe("computeMigrationChecksum（schema engine の render_checksum と同じ形）", () => {
  it("Prisma の checksum.rs のテストと同じ値になる（\"hello\"。64文字・小文字・ゼロ埋め）", () => {
    const checksum = computeMigrationChecksum(bytes("hello"));
    expect(checksum).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("改行コード（LF・CRLF）・末尾の改行・1バイトの違いで値が変わる（正規化しない）", () => {
    const lf = computeMigrationChecksum(bytes("CREATE TABLE a ();\nSELECT 1;\n"));
    expect(computeMigrationChecksum(bytes("CREATE TABLE a ();\r\nSELECT 1;\r\n"))).not.toBe(lf);
    expect(computeMigrationChecksum(bytes("CREATE TABLE a ();\nSELECT 1;"))).not.toBe(lf);
    expect(computeMigrationChecksum(bytes("CREATE TABLE a ();\nSELECT 2;\n"))).not.toBe(lf);
    expect(computeMigrationChecksum(bytes("CREATE TABLE a ();\nSELECT 1;\n"))).toBe(lf);
  });
});

describe("readLocalMigrationChecksums：ローカルの checksum", () => {
  it("リポジトリの prisma/migrations：listMigrationNames と同じ名前で、各 migration.sql の SHA-256 を返す（読み取りだけ）", () => {
    const dir = path.join(REPO_ROOT, "prisma", "migrations");
    const local = readLocalMigrationChecksums(dir);
    expect(local.map((m) => m.name)).toEqual(listMigrationNames(dir));
    expect(local).toHaveLength(8);
    for (const m of local) {
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(m.checksum).toBe(computeMigrationChecksum(readFileSync(path.join(dir, m.name, "migration.sql"))));
    }
  });

  it("名前順に、名前と checksum を対応付けて返す。migration_lock.toml は対象外。読み取りの操作だけを使う", () => {
    const fs = fakeFs();
    expect(readLocalMigrationChecksums(DIR, fs)).toEqual(LOCAL);
    expect(fs.calls.every((call) => /^(lstat|readdir|realpath|readFile):/.test(call))).toBe(true);
    expect(fs.calls.filter((c) => c.startsWith("readFile:"))).toEqual(LOCAL.map((m) => `readFile:${DIR}/${m.name}/migration.sql`));
  });

  it("migration.sql の1バイトの違いは、別の checksum になる", () => {
    const changed = readLocalMigrationChecksums(DIR, fakeFs({ nodes: { [`${DIR}/${M2}/migration.sql`]: { kind: "file", content: bytes("ALTER TABLE a ADD COLUMN c int;\n") } } }));
    expect(changed.find((m) => m.name === M2)?.checksum).not.toBe(LOCAL[1].checksum);
    expect(changed.find((m) => m.name === M1)?.checksum).toBe(LOCAL[0].checksum);
  });

  it.each<[string, Parameters<typeof fakeFs>[0], MigrationChecksumErrorCode]>([
    ["migration.sql がない", { nodes: { [`${DIR}/${M2}/migration.sql`]: undefined } }, "MIGRATION_FILE_MISSING"],
    ["migration のディレクトリに別のファイルがある", { nodes: { [`${DIR}/${M2}/notes.txt`]: { kind: "file", content: bytes("x") } } }, "UNEXPECTED_ENTRY"],
    ["migrations の直下に想定外のファイルがある", { nodes: { [`${DIR}/README.md`]: { kind: "file", content: bytes("x") } } }, "UNEXPECTED_ENTRY"],
    ["migration のディレクトリがシンボリックリンク", { nodes: { [`${DIR}/20260104000000_linked`]: { kind: "symlink" } } }, "UNEXPECTED_ENTRY"],
    ["migration.sql がシンボリックリンク", { nodes: { [`${DIR}/${M2}/migration.sql`]: { kind: "symlink" } } }, "MIGRATION_FILE_INVALID"],
    ["migration.sql の実体が migrations の外", { realpaths: { [`${DIR}/${M2}/migration.sql`]: "/etc/passwd" } }, "MIGRATION_FILE_INVALID"],
    ["migration.sql がディレクトリ", { nodes: { [`${DIR}/${M2}/migration.sql`]: { kind: "dir" } } }, "MIGRATION_FILE_INVALID"],
    ["migration の名前が不正（..）", { nodes: { [`${DIR}/..hidden`]: { kind: "dir" } } }, "MIGRATION_NAME_INVALID"],
    ["migration の名前が不正（時刻なし）", { nodes: { [`${DIR}/manual_fix`]: { kind: "dir" } } }, "MIGRATION_NAME_INVALID"],
    ["migrations がシンボリックリンク", { nodes: { [DIR]: { kind: "symlink" } } }, "MIGRATIONS_DIR_INVALID"],
    ["migrations がない", { nodes: { [DIR]: undefined } }, "MIGRATIONS_DIR_INVALID"],
    ["読み取りの失敗（EACCES）", { readErrors: { [`${DIR}/${M2}/migration.sql`]: "EACCES" } }, "MIGRATION_FILE_UNREADABLE"],
    ["無効な UTF-8", { nodes: { [`${DIR}/${M2}/migration.sql`]: { kind: "file", content: new Uint8Array([0x53, 0xff, 0x0a]) } } }, "ENCODING_UNSUPPORTED"],
    ["UTF-8 の BOM", { nodes: { [`${DIR}/${M2}/migration.sql`]: { kind: "file", content: new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("SELECT 1;\n")]) } } }, "ENCODING_UNSUPPORTED"],
  ])("%s なら、その時点で止まる（秘密情報・ファイルの中身を含めない）", (_label, overrides, code) => {
    const error = expectChecksumError(() => readLocalMigrationChecksums(DIR, fakeFs(overrides)), code);
    expect(error.message).not.toContain("CREATE TABLE");
  });

  it("migration が1件もなければ止まる", () => {
    const nodes: Record<string, FakeNode | undefined> = {};
    for (const name of Object.keys(SQL)) {
      nodes[`${DIR}/${name}`] = undefined;
      nodes[`${DIR}/${name}/migration.sql`] = undefined;
    }
    expectChecksumError(() => readLocalMigrationChecksums(DIR, fakeFs({ nodes })), "NO_MIGRATIONS");
  });

  it("読み取りの失敗は、エラーコードだけを示す（元のメッセージ・パスワードは含めない）", () => {
    const error = expectChecksumError(() => readLocalMigrationChecksums(DIR, fakeFs({ readErrors: { [`${DIR}/${M1}/migration.sql`]: "EIO" } })), "MIGRATION_FILE_UNREADABLE");
    expect(error.message).toContain(`${M1}/migration.sql could not be read (EIO)`);
  });
});

describe("compareMigrationChecksums：DB の履歴との照合（偽の履歴）", () => {
  it("すべて一致（名前・checksum・完了・ロールバックなし）", () => {
    const result = compareMigrationChecksums(goodRows(), LOCAL);
    expect(result.matches).toBe(true);
    expect(() => assertMigrationChecksums(result)).not.toThrow();
  });

  it.each<[string, (rows: ReturnType<typeof goodRows>) => Record<string, unknown>[], Partial<Record<string, unknown>>]>([
    ["1件の checksum の不一致", (r) => r.map((row) => (row.name === M2 ? { ...row, checksum: computeMigrationChecksum(bytes("other")) } : row)), { checksumMismatch: [M2] }],
    ["checksum が旧形式・大文字（形が違う）", (r) => r.map((row) => (row.name === M2 ? { ...row, checksum: row.checksum.toUpperCase() } : row)), { checksumMismatch: [M2] }],
    ["DB の履歴の不足", (r) => r.filter((row) => row.name !== M3), { missing: [M3] }],
    ["余分な migration", (r) => [...r, { name: "20260109000000_extra", checksum: LOCAL[0].checksum, finished: true, rolledBack: false }], { extra: ["20260109000000_extra"] }],
    ["migration 名の重複（失敗の記録を含む）", (r) => [...r, { ...r[0], finished: false }], { duplicated: [M1] }],
    ["未完了の migration", (r) => r.map((row) => (row.name === M2 ? { ...row, finished: false } : row)), { unfinished: [M2] }],
    ["ロールバックされた migration", (r) => r.map((row) => (row.name === M2 ? { ...row, rolledBack: true } : row)), { rolledBack: [M2] }],
    ["不正な行（checksum が NULL）", (r) => r.map((row) => (row.name === M2 ? { ...row, checksum: null } : row)), { invalidRows: 1, missing: [M2] }],
    ["不正な行（完了の値が真偽値でない）", (r) => r.map((row) => (row.name === M2 ? { ...row, finished: "t" } : row)), { invalidRows: 1, missing: [M2] }],
  ])("%s は不一致（1件でも検証失敗）", (_label, mutate, expected) => {
    const result = compareMigrationChecksums(mutate(goodRows()), LOCAL);
    expect(result.matches).toBe(false);
    expect(result).toMatchObject(expected);
    const error = expectChecksumError(() => assertMigrationChecksums(result), "CHECKSUM_HISTORY_MISMATCH");
    // checksum の値は表示しない
    for (const m of LOCAL) expect(error.message).not.toContain(m.checksum);
  });

  it("DB の履歴が空なら、すべて不足として不一致", () => {
    const result = compareMigrationChecksums([], LOCAL);
    expect(result).toMatchObject({ matches: false, missing: [M1, M2, M3] });
  });

  it("ローカルの一覧に重複があれば、照合せずに止まる", () => {
    expectChecksumError(() => compareMigrationChecksums(goodRows(), [...LOCAL, LOCAL[0]]), "DUPLICATE_LOCAL_MIGRATION");
  });
});

/** 偽のDBクライアント（実DBには接続しない）。送られた SQL を記録する */
function fakeClient(options: { rows?: Record<string, unknown>[]; identity?: Record<string, unknown>; failOn?: string } = {}) {
  const queries: string[] = [];
  const end = vi.fn(async () => undefined);
  const client: IntegrationDbClient = {
    query: async (sql: string) => {
      queries.push(sql);
      if (options.failOn && sql.includes(options.failOn)) throw Object.assign(new Error(`boom ${TEST_URL}`), { code: "42P01" });
      if (sql === "BEGIN READ ONLY" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("set_config")) return { rows: [{ searchPath: "pg_catalog" }] };
      if (sql.includes("transaction_read_only")) return { rows: [{ transaction_read_only: "on" }] };
      if (sql.includes("current_database()")) {
        return {
          rows: [options.identity ?? { database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 }],
        };
      }
      if (sql === MIGRATION_CHECKSUM_SQL) return { rows: options.rows ?? goodRows() };
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
    end,
  };
  return { client, queries, end, connect: vi.fn(async () => client) };
}

describe("inspectMigrationChecksums：読み取り専用の照合（偽のDBクライアント。実DBには接続しない）", () => {
  it("一致：BEGIN READ ONLY → search_path の固定 → 本人確認 → 履歴の SELECT → ROLLBACK → 接続の解放。読み取りの SQL だけ", async () => {
    const db = fakeClient();
    const result = await inspectMigrationChecksums({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs() });
    expect(result.matches).toBe(true);
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.connect).toHaveBeenCalledWith(TEST_URL);
    expect(db.queries[0]).toBe("BEGIN READ ONLY");
    expect(db.queries[1]).toContain("set_config('search_path', 'pg_catalog', true)");
    expect(db.queries[2]).toContain("SHOW transaction_read_only");
    expect(db.queries[3]).toContain("current_database()");
    expect(db.queries[4]).toBe(MIGRATION_CHECKSUM_SQL);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
    for (const sql of db.queries) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE)\b/i);
  });

  it("不一致は結果として返す（DB は変更しない。ROLLBACK して閉じる）", async () => {
    const db = fakeClient({ rows: goodRows().map((r) => (r.name === M1 ? { ...r, rolledBack: true } : r)) });
    const result = await inspectMigrationChecksums({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs() });
    expect(result).toMatchObject({ matches: false, rolledBack: [M1] });
    expect(db.queries.at(-1)).toBe("ROLLBACK");
  });

  it("ローカルの読み取りに失敗したら、接続しない", async () => {
    const db = fakeClient();
    await expect(
      inspectMigrationChecksums({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs({ nodes: { [`${DIR}/${M1}/migration.sql`]: undefined } }) }),
    ).rejects.toMatchObject({ code: "MIGRATION_FILE_MISSING" });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("開発用DBの接続先なら、接続せずに拒否する", async () => {
    const db = fakeClient();
    const error = await inspectMigrationChecksums({ databaseUrl: DEV_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationChecksumError);
    expect((error as MigrationChecksumError).code).toBe("TARGET_REJECTED");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("本人確認に失敗したら、履歴を読まずに止まる（ROLLBACK して閉じる）", async () => {
    const db = fakeClient({ identity: { database: "katana", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: TEST_DATABASE_MARKER, serverPort: 5432 } });
    await expect(inspectMigrationChecksums({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs() })).rejects.toMatchObject({
      code: "DATABASE_MISMATCH",
    });
    expect(db.queries).not.toContain(MIGRATION_CHECKSUM_SQL);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("履歴の SQL が失敗したら止まり、ドライバのメッセージ（接続URL）を表示しない", async () => {
    const db = fakeClient({ failOn: "_prisma_migrations" });
    const error = await inspectMigrationChecksums({ databaseUrl: TEST_URL, developmentDatabaseUrl: DEV_URL, migrationsDir: DIR, connect: db.connect, fs: fakeFs() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationDatabaseCheckError);
    expect((error as Error).message).toContain("(42P01)");
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(db.queries.at(-1)).toBe("ROLLBACK");
  });
});

describe("migrationChecksum の静的な確認（ソース）", () => {
  // コメントを除いたコード（コメントの中の名前で誤って一致させない）
  const source = readFileSync(path.join(REPO_ROOT, "lib/testing/migrationChecksum.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

  it("DB ドライバ・Prisma Client を読み込まず、ファイルへの書き込みの操作を使わない", () => {
    for (const forbidden of ['from "pg"', "@prisma/client", "@/lib/prisma", "testDbConnection", "child_process", "writeFile", "appendFile", "rmSync", "unlink", "mkdir", "rename"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("履歴の SQL は SELECT だけで、テーブルをスキーマで修飾する", () => {
    expect(MIGRATION_CHECKSUM_SQL.trimStart().startsWith("SELECT ")).toBe(true);
    expect(MIGRATION_CHECKSUM_SQL).toContain('FROM "public"."_prisma_migrations"');
    expect(MIGRATION_CHECKSUM_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|GRANT)\b/i);
  });

  it("migration の適用・統合テストの経路からは呼ばない（呼ぶのは、checksum 専用の scripts/testdb-checksums.mts と lib/testing/testDbChecksums.ts だけ。Step 3-12B-5C-1）", () => {
    for (const file of ["scripts/testdb-migrate.mts", "scripts/testdb.mts", "scripts/test-integration.mts", "lib/testing/testDbMigrate.ts", "lib/testing/integrationGlobalSetup.ts", "lib/testing/schemaDiff.ts"]) {
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8")).not.toContain("migrationChecksum");
    }
    expect(readFileSync(path.join(REPO_ROOT, "scripts/testdb-checksums.mts"), "utf8")).toContain('from "../lib/testing/migrationChecksum.ts"');
    expect(readFileSync(path.join(REPO_ROOT, "lib/testing/testDbChecksums.ts"), "utf8")).toContain('from "./migrationChecksum.ts"');
  });
});
