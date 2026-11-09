import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertTestDatabaseTarget, TestDatabaseGuardError } from "../db/testDatabaseGuard.ts";
import {
  assertDatabaseIdentity,
  type IntegrationDbClient,
  MIGRATIONS_TABLE,
  quoteIdentifier,
  runReadOnlyCheck,
  select,
} from "./integrationDatabaseCheck.ts";
import { pinSearchPath } from "./testDbState.ts";

/**
 * migration の checksum の照合（Step 3-12B-5A。完了条件2の一部）。
 *
 * `_prisma_migrations.checksum` と、ローカルの `prisma/migrations/<name>/migration.sql` の SHA-256 を照合する。
 * このモジュールは DB ドライバを読み込まない。呼び出し元は checksum 専用の lib/testing/testDbChecksums.ts（scripts/testdb-checksums.mts）だけで、
 * 実DBへの接続は、その固定のゲート（CHECKSUM_DATABASE_DISABLED。Step 3-12B-5C-1 では無効）が有効なときだけ行う。
 *
 * Prisma の checksum の仕様（インストール済みの prisma 7.2.0、engines 0c8ef2ce45c83248ab3df073180d5eda9e8be7a3 で確認）:
 * - CLI（node_modules/prisma/build/index.js）は、prisma/migrations の直下のディレクトリ（Dirent.isDirectory()。シンボリックリンクは対象外）
 *   ごとに `migration.sql` を `readFile(..., { encoding: "utf-8" })` で読み、その文字列をそのまま schema engine に渡す。
 * - schema engine（schema-engine/connectors/schema-connector/src/checksum.rs）は、その文字列の UTF-8 のバイト列の SHA-256 を、
 *   各バイト2桁・小文字・ゼロ埋めの16進（64文字）で記録する（render_checksum。改行の正規化はしない）。
 * - Prisma 自身の照合（script_matches_checksum）は寛容で、CRLF↔LF を入れ替えた版と、旧形式（ゼロ埋めなし）の16進も一致とみなす。
 *
 * この照合は Prisma より厳しくする（fail-closed）:
 * - ファイルのバイト列そのものの SHA-256（64文字・小文字）と、DB の値の完全一致だけを一致とする。改行の入れ替え・旧形式は不一致として扱う。
 * - 有効な UTF-8 の場合だけ、「バイト列の SHA-256」と「Prisma が読んだ文字列の SHA-256」は同じになる。
 *   無効な UTF-8 は Prisma の読み込みで置換文字に変わり得て、同じ値を再現できないので拒否する（ENCODING_UNSUPPORTED）。
 *   UTF-8 の BOM の扱いも、推測で合わせずに拒否する。
 * - prisma/migrations の直下には、migration のディレクトリと `migration_lock.toml` だけを許す。各ディレクトリには `migration.sql` だけを許す。
 *   シンボリックリンク・想定外のファイル・migrations の外を指す実体は拒否する（UNEXPECTED_ENTRY・MIGRATION_FILE_INVALID）。
 *
 * 例外・結果のメッセージには、ファイルの中身・checksum の値・接続URL・パスワード・ドライバのエラーメッセージを含めない
 * （エラーコード・migration の名前・件数だけ）。ファイルは読むだけで、変更しない。
 */

export const MIGRATION_SCRIPT_FILE = "migration.sql";
export const MIGRATION_LOCK_FILE = "migration_lock.toml";
/** Prisma の migration のディレクトリ名（`{14桁の時刻}_{名前}`）。これ以外の名前は拒否する */
const MIGRATION_NAME = /^\d{14}_[A-Za-z0-9_]+$/;
/** schema engine の render_checksum の形（SHA-256、64文字、小文字の16進） */
const CHECKSUM_FORMAT = /^[0-9a-f]{64}$/;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export type MigrationChecksumErrorCode =
  | "MIGRATIONS_DIR_INVALID"
  | "UNEXPECTED_ENTRY"
  | "MIGRATION_NAME_INVALID"
  | "MIGRATION_FILE_MISSING"
  | "MIGRATION_FILE_INVALID"
  | "MIGRATION_FILE_UNREADABLE"
  | "ENCODING_UNSUPPORTED"
  | "NO_MIGRATIONS"
  | "DUPLICATE_LOCAL_MIGRATION"
  | "TARGET_REJECTED"
  | "CHECKSUM_HISTORY_MISMATCH";

export class MigrationChecksumError extends Error {
  readonly code: MigrationChecksumErrorCode;

  constructor(code: MigrationChecksumErrorCode, detail: string) {
    super(`[migrationChecksum] ${code}: ${detail}`);
    this.name = "MigrationChecksumError";
    this.code = code;
  }
}

/** ファイルシステムの読み取りだけ（単体テストでは偽のものに差し替える）。書き込みの操作は持たない */
export type MigrationDirent = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
export type MigrationFs = {
  lstat(absolutePath: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
  readdir(absolutePath: string): MigrationDirent[];
  realpath(absolutePath: string): string;
  readFile(absolutePath: string): Uint8Array;
};

export const NODE_MIGRATION_FS: MigrationFs = {
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p, { withFileTypes: true }),
  realpath: (p) => realpathSync(p),
  readFile: (p) => readFileSync(p),
};

export type LocalMigrationChecksum = { name: string; checksum: string };

/** バイト列の SHA-256 を、schema engine の render_checksum と同じ形（64文字・小文字・ゼロ埋め）で返す */
export function computeMigrationChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** ファイルシステムのエラーから、コード（ENOENT など）だけを取り出す（パス・メッセージは含めない） */
function fsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "unknown";
}

function assertValidUtf8WithoutBom(name: string, bytes: Uint8Array): void {
  if (bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b)) {
    throw new MigrationChecksumError("ENCODING_UNSUPPORTED", `${name}/${MIGRATION_SCRIPT_FILE} starts with a UTF-8 BOM; refusing to guess how Prisma hashed it.`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MigrationChecksumError("ENCODING_UNSUPPORTED", `${name}/${MIGRATION_SCRIPT_FILE} is not valid UTF-8; its Prisma checksum cannot be reproduced.`);
  }
}

/**
 * prisma/migrations の各 migration.sql を読み、名前と checksum を名前順で返す。ファイルは変更しない。
 * 想定外の構成（シンボリックリンク・想定外のファイル・不正な名前・migration.sql の欠落・読み取りの失敗・無効な UTF-8）は、その時点で例外にする。
 */
export function readLocalMigrationChecksums(migrationsDir: string, fs: MigrationFs = NODE_MIGRATION_FS): LocalMigrationChecksum[] {
  const dir = path.resolve(migrationsDir);
  let realDir: string;
  try {
    const stat = fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MigrationChecksumError("MIGRATIONS_DIR_INVALID", "the migrations directory is not a real directory.");
    }
    realDir = fs.realpath(dir);
  } catch (error) {
    if (error instanceof MigrationChecksumError) throw error;
    throw new MigrationChecksumError("MIGRATIONS_DIR_INVALID", `the migrations directory could not be read (${fsErrorCode(error)}).`);
  }

  let entries: MigrationDirent[];
  try {
    entries = fs.readdir(dir);
  } catch (error) {
    throw new MigrationChecksumError("MIGRATIONS_DIR_INVALID", `the migrations directory could not be listed (${fsErrorCode(error)}).`);
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === MIGRATION_LOCK_FILE && entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MigrationChecksumError("UNEXPECTED_ENTRY", `unexpected entry in the migrations directory: ${JSON.stringify(entry.name)}.`);
    }
    if (!MIGRATION_NAME.test(entry.name)) {
      throw new MigrationChecksumError("MIGRATION_NAME_INVALID", `unexpected migration directory name: ${JSON.stringify(entry.name)}.`);
    }
    names.push(entry.name);
  }
  if (names.length === 0) throw new MigrationChecksumError("NO_MIGRATIONS", "no migrations were found.");
  if (new Set(names).size !== names.length) throw new MigrationChecksumError("DUPLICATE_LOCAL_MIGRATION", "duplicate migration directory names were listed.");

  return names.sort().map((name) => {
    const migrationDir = path.join(dir, name);
    let files: MigrationDirent[];
    try {
      files = fs.readdir(migrationDir);
    } catch (error) {
      throw new MigrationChecksumError("MIGRATION_FILE_UNREADABLE", `${name} could not be listed (${fsErrorCode(error)}).`);
    }
    const others = files.filter((f) => f.name !== MIGRATION_SCRIPT_FILE);
    if (others.length > 0) {
      throw new MigrationChecksumError("UNEXPECTED_ENTRY", `${name} contains files other than ${MIGRATION_SCRIPT_FILE}.`);
    }
    const script = files.find((f) => f.name === MIGRATION_SCRIPT_FILE);
    if (script === undefined) throw new MigrationChecksumError("MIGRATION_FILE_MISSING", `${name}/${MIGRATION_SCRIPT_FILE} is missing.`);

    const filePath = path.join(migrationDir, MIGRATION_SCRIPT_FILE);
    let bytes: Uint8Array;
    try {
      const stat = fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || !script.isFile() || script.isSymbolicLink()) {
        throw new MigrationChecksumError("MIGRATION_FILE_INVALID", `${name}/${MIGRATION_SCRIPT_FILE} is not a regular file.`);
      }
      // 実体が migrations の中の同じ場所であること（親ディレクトリのシンボリックリンクなどで外を指していない）
      if (fs.realpath(filePath) !== path.join(realDir, name, MIGRATION_SCRIPT_FILE)) {
        throw new MigrationChecksumError("MIGRATION_FILE_INVALID", `${name}/${MIGRATION_SCRIPT_FILE} resolves outside the migrations directory.`);
      }
      bytes = fs.readFile(filePath);
    } catch (error) {
      if (error instanceof MigrationChecksumError) throw error;
      throw new MigrationChecksumError("MIGRATION_FILE_UNREADABLE", `${name}/${MIGRATION_SCRIPT_FILE} could not be read (${fsErrorCode(error)}).`);
    }
    assertValidUtf8WithoutBom(name, bytes);
    return { name, checksum: computeMigrationChecksum(bytes) };
  });
}

/** `_prisma_migrations` の行（readMigrationChecksumRows の結果。型は検証前） */
export type MigrationChecksumRow = Record<string, unknown>;

export type MigrationChecksumComparison = {
  /** ローカルにあるのに、DB に行がないもの */
  missing: string[];
  /** DB にあるのに、ローカルにないもの */
  extra: string[];
  /** DB に2行以上あるもの（成功・失敗を問わない） */
  duplicated: string[];
  /** checksum が一致しないもの */
  checksumMismatch: string[];
  /** finished_at が NULL のもの */
  unfinished: string[];
  /** rolled_back_at が NULL でないもの */
  rolledBack: string[];
  /** 名前・checksum・状態の型や形が想定外の行の件数 */
  invalidRows: number;
  matches: boolean;
};

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * DB の履歴とローカルの checksum を照合する（純粋関数）。ローカルの一覧を期待値とし、件数を固定しない。
 * 1件でも不一致・不正な行があれば matches は false。
 */
export function compareMigrationChecksums(rows: readonly MigrationChecksumRow[], local: readonly LocalMigrationChecksum[]): MigrationChecksumComparison {
  const expected = new Map(local.map((m) => [m.name, m.checksum]));
  if (expected.size !== local.length) throw new MigrationChecksumError("DUPLICATE_LOCAL_MIGRATION", "the local migration list has duplicates.");

  let invalidRows = 0;
  const byName = new Map<string, MigrationChecksumRow[]>();
  for (const row of rows) {
    const valid =
      typeof row.name === "string" && row.name !== "" && typeof row.checksum === "string" && isBoolean(row.finished) && isBoolean(row.rolledBack);
    if (!valid) {
      invalidRows += 1;
      continue;
    }
    const list = byName.get(row.name as string) ?? [];
    list.push(row);
    byName.set(row.name as string, list);
  }

  const sorted = (values: Iterable<string>) => [...values].sort();
  const duplicated = sorted([...byName].filter(([, list]) => list.length > 1).map(([name]) => name));
  const extra = sorted([...byName.keys()].filter((name) => !expected.has(name)));
  const missing = sorted([...expected.keys()].filter((name) => !byName.has(name)));
  const checksumMismatch: string[] = [];
  const unfinished: string[] = [];
  const rolledBack: string[] = [];
  for (const [name, checksum] of expected) {
    const list = byName.get(name);
    if (list === undefined || list.length !== 1) continue; // missing・duplicated で不一致として扱う
    const [row] = list;
    if (row.finished !== true) unfinished.push(name);
    if (row.rolledBack !== false) rolledBack.push(name);
    if (!CHECKSUM_FORMAT.test(row.checksum as string) || row.checksum !== checksum) checksumMismatch.push(name);
  }

  const matches =
    invalidRows === 0 &&
    duplicated.length === 0 &&
    extra.length === 0 &&
    missing.length === 0 &&
    checksumMismatch.length === 0 &&
    unfinished.length === 0 &&
    rolledBack.length === 0;
  return { missing, extra, duplicated, checksumMismatch: checksumMismatch.sort(), unfinished: unfinished.sort(), rolledBack: rolledBack.sort(), invalidRows, matches };
}

/** 照合の結果が不一致なら、名前と件数だけを含む例外にする（checksum の値は含めない） */
export function assertMigrationChecksums(comparison: MigrationChecksumComparison): void {
  if (comparison.matches) return;
  const parts = [
    ["missing", comparison.missing],
    ["extra", comparison.extra],
    ["duplicated", comparison.duplicated],
    ["checksum mismatch", comparison.checksumMismatch],
    ["unfinished", comparison.unfinished],
    ["rolled back", comparison.rolledBack],
  ] as const;
  const detail = parts
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => `${label}: ${names.join(", ")}`)
    .concat(comparison.invalidRows > 0 ? [`invalid rows: ${comparison.invalidRows}`] : []);
  throw new MigrationChecksumError("CHECKSUM_HISTORY_MISMATCH", `the migration history does not match the local migrations (${detail.join("; ")}).`);
}

/** `_prisma_migrations` の名前・checksum・完了・ロールバックを読む（SELECT だけ。テーブルはスキーマで修飾する） */
export const MIGRATION_CHECKSUM_SQL = `SELECT migration_name AS name, checksum,
            finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
       FROM ${quoteIdentifier("public")}.${quoteIdentifier(MIGRATIONS_TABLE)}`;

export async function readMigrationChecksumRows(client: IntegrationDbClient): Promise<MigrationChecksumRow[]> {
  return select(client, "migration checksum listing", MIGRATION_CHECKSUM_SQL);
}

export type InspectMigrationChecksumsInput = {
  /** `.env.test` の検証済みの接続URL */
  databaseUrl: string;
  /** `.env` の開発用DBの接続URL（同じ接続先でないことの確認にだけ使う） */
  developmentDatabaseUrl: string | undefined;
  migrationsDir: string;
  /** 検証済みの接続URLで1回だけ接続する（lib/testing/testDbConnection.ts の connectTestDatabase を渡す想定） */
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
  fs?: MigrationFs;
};

/**
 * ローカルの checksum を計算してから、読み取り専用の接続で DB の履歴と照合する（lib/testing/testDbChecksums.ts から、固定のゲートが有効なときだけ呼ぶ。Step 3-12B-5C-1 では無効）。
 * 順序：ローカルの読み取り（失敗なら接続しない）→ 接続先の検証（接続しない）→ 接続 → BEGIN READ ONLY → search_path の固定
 * → 本人確認 → 履歴の SELECT → ROLLBACK → 接続の解放（runReadOnlyCheck）。照合の結果を返すだけで、DB は変更しない。
 * Docker の識別情報の照合は、呼び出し側（runner）で行う。
 */
export async function inspectMigrationChecksums(input: InspectMigrationChecksumsInput): Promise<MigrationChecksumComparison> {
  const local = readLocalMigrationChecksums(input.migrationsDir, input.fs);
  try {
    assertTestDatabaseTarget({ databaseUrl: input.databaseUrl, env: {}, developmentDatabaseUrl: input.developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new MigrationChecksumError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    throw error;
  }
  return runReadOnlyCheck(input.connect, input.databaseUrl, async (client) => {
    await pinSearchPath(client);
    await assertDatabaseIdentity(client); // 失敗したら throw され、履歴を読まない
    return compareMigrationChecksums(await readMigrationChecksumRows(client), local);
  });
}
