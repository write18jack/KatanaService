import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertTestDatabaseTarget, TestDatabaseGuardError } from "../db/testDatabaseGuard.ts";
import {
  applicationTablesFromSchema,
  assertDatabaseIdentity,
  assertSupportedSchema,
  IntegrationDatabaseCheckError,
  type IntegrationDbClient,
  listMigrationNames,
  MIGRATIONS_TABLE,
  runReadOnlyCheck,
  select,
} from "./integrationDatabaseCheck.ts";
import { type PinnedServerExpectation, pinnedServerMismatches } from "./testDbIdentity.ts";
import {
  classifyCatalogInventory,
  enumNamesFromSchema,
  pinSearchPath,
  readCatalogInventory,
  readServerIdentity,
  type TestDatabaseExpectation,
} from "./testDbState.ts";

/**
 * テストDBの PostgreSQL カタログの読み取り専用の検査（Step 3-12B-5C-5B。条件2-B の補助）。
 *
 * **このモジュールは、どのスクリプトからも呼ばない。** 実DBでの実行は、承認を得た後続の工程で組み込む。
 * DB への接続は呼び出し側が `connect` として渡す（このファイルは DB ドライバ・Docker・子プロセスを読み込まない）。
 *
 * 目的は3つ。Prisma の `migrate diff` の代わり（Prisma schema との完全な比較）ではない:
 * A. 定義の検査（auditCatalogDefinitions）：Prisma の `migrate diff` が比べない・比べるかが未確認の、DB 固有の定義
 *    （CHECK・除外制約・制約トリガー・部分インデックス・式インデックス・RLS の設定とポリシー・enum の値と順序）。
 *    想定外のスキーマ・拡張・関数・ビュー・トリガー・ポリシーの件数などは、状態 C の判定（classifyCatalogInventory）を再利用する。
 * B. 読み取り専用ロールの検査（classifyReadOnlyRoleSnapshot）：将来の katana_test_ro から、Prisma が読む列がすべて見えること、
 *    書き込み権限・所有権・ロールの所属がないこと。**今は katana_test_ro が存在しないので、偽のクライアントでだけ使う。**
 * C. カタログの fingerprint（readCatalogFingerprint・compareCatalogFingerprints）：Prisma CLI の前後で、DB の定義・重要な権限の
 *    設定が変わっていないことの比較。**fingerprint の一致は「2回の観測の間で定義が変わっていない」ことの証拠で、
 *    Prisma schema との一致の証拠ではない**（型の名前・meaning で区別する）。
 *    fingerprint の対象外（変わっても検出しない）：オブジェクトのコメント（obj_description など。DB のコメントだけは対象）、
 *    統計情報、テーブルの行データ、sequence の現在値、pg_authid に保存される認証情報（パスワード）、セッションの中だけの状態
 *    （SET・一時オブジェクト・advisory lock など）。ロールの設定値は、秘密情報を含み得るので、DB の中で md5 にしてから読む。
 *
 * runCatalogDefinitionAudit の passed は「カタログの定義の監査」の成功で、状態 C 全体の証明ではない
 * （migration の履歴・テーブルが空であることは含まない。classifyCatalogInventory の構造の判定だけを再利用している）。
 * 将来の実行経路では、既存の F1（inspectTestDatabase。状態 C・権限・識別情報）との併用を必須とする。
 *
 * 期待値は DB から独立した、バージョン管理されたファイルから作る（buildCatalogAuditExpectation）:
 * - テーブル：prisma/schema.prisma（applicationTablesFromSchema）。
 * - enum の値と順序：prisma/migrations の SQL を順に再現する（CREATE TYPE … AS ENUM・ADD VALUE・RENAME・DROP TYPE）。
 *   PostgreSQL の enum の順序は、作った順序と ADD VALUE の位置で決まり、schema.prisma の並びとは一致しないことがあるため。
 *   値の集合は schema.prisma と照合し、食い違えば期待値を確定できないものとする。対応していない文があれば、同じく確定できない。
 * - DB 固有の定義：migration の SQL に、CHECK・EXCLUDE・RLS・POLICY・TRIGGER・FUNCTION・VIEW・EXTENSION・単純な形でない INDEX が
 *   1つもなければ、DB にも存在しないことを期待する（今の8件はこれに当たる）。1つでもあれば、レビュー済みの期待値の仕組みが
 *   まだないので、期待値を確定できないものとする（「永久に0件」とは決めつけない）。
 * 期待値を確定できない項目があれば、結果は unverified で、成功とは扱わない。
 *
 * 実DBで実行するときの順序（runCatalogDefinitionAudit。既存の部品を使う）:
 * 1. assertTestDatabaseTarget（接続しない）  2. 接続・BEGIN READ ONLY（runReadOnlyCheck）  3. search_path=pg_catalog（pinSearchPath）
 * 4. transaction_read_only=on と 5. 本人確認（assertDatabaseIdentity）  6. サーバーの識別（readServerIdentity・pinnedServerMismatches）
 * 7. カタログの SELECT  8. 分類  9. ROLLBACK  10. 接続の解放（runReadOnlyCheck）。
 * このモジュールの SQL は SELECT だけ（SHOW・set_config は既存の部品の中）。CREATE・ALTER・DROP・GRANT・REVOKE・INSERT・UPDATE・DELETE は使わない。
 * 例外・結果のメッセージには、接続URL・パスワード・ドライバのエラーメッセージ・SQL の全文を含めない（コード・分類・名前・件数だけ）。
 */

const APP_SCHEMA = "public";

// ---- エラーと結果の分類 ----

export type CatalogAuditErrorCode =
  | "TARGET_REJECTED"
  | "CONNECT_FAILED"
  | "CATALOG_QUERY_FAILED"
  | "IDENTITY_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "INVALID_CATALOG_RESULT"
  | "TRANSACTION_CLOSE_FAILED"
  | "EXPECTATION_INVALID"
  | "FINGERPRINT_MISMATCH";

export class CatalogAuditError extends Error {
  readonly code: CatalogAuditErrorCode;

  constructor(code: CatalogAuditErrorCode, detail: string) {
    super(`[catalogAudit] ${code}: ${detail}`);
    this.name = "CatalogAuditError";
    this.code = code;
  }
}

/** 検査の結果の分類（実行の失敗は CatalogAuditError、内容の不一致は findings） */
export type CatalogAuditCategory =
  | "UNEXPECTED_OBJECT"
  | "MISSING_OBJECT"
  | "ENUM_MISMATCH"
  | "COLUMN_VISIBILITY_INSUFFICIENT"
  | "READ_ONLY_ROLE_PRIVILEGE_VIOLATION"
  | "EXPECTATION_UNSUPPORTED";

export type CatalogAuditFinding = { readonly category: CatalogAuditCategory; readonly items: readonly string[] };

/**
 * passed：期待値をすべて確定でき、不一致が0件。failed：不一致が1件以上。
 * unverified：不一致はないが、期待値を確定できない項目がある（成功とは扱わない）。
 */
export type CatalogAuditReport = { readonly verdict: "passed" | "failed" | "unverified"; readonly findings: readonly CatalogAuditFinding[] };

const MAX_ITEMS = 20;

function finding(category: CatalogAuditCategory, items: readonly string[]): CatalogAuditFinding[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort();
  const shown = sorted.slice(0, MAX_ITEMS);
  return [{ category, items: sorted.length > MAX_ITEMS ? [...shown, `(and ${sorted.length - MAX_ITEMS} more)`] : shown }];
}

function report(findings: CatalogAuditFinding[]): CatalogAuditReport {
  const failed = findings.some((f) => f.category !== "EXPECTATION_UNSUPPORTED");
  const unsupported = findings.some((f) => f.category === "EXPECTATION_UNSUPPORTED");
  return { verdict: failed ? "failed" : unsupported ? "unverified" : "passed", findings };
}

export function catalogAuditPassed(result: CatalogAuditReport): boolean {
  return result.verdict === "passed";
}

// ---- 期待値（DB から独立したリポジトリのファイル） ----

export type MigrationSource = { readonly name: string; readonly sql: string };

export type EnumExpectation =
  | { readonly status: "supported"; readonly enums: Readonly<Record<string, readonly string[]>> }
  | { readonly status: "unsupported"; readonly reasons: readonly string[] };

export type DbSpecificExpectation =
  | { readonly status: "supported" }
  | { readonly status: "unsupported"; readonly reasons: readonly string[] };

export type CatalogAuditExpectation = {
  /** 状態 C の判定（classifyCatalogInventory）に渡す期待値（テーブル・enum の名前・migration の名前） */
  readonly inventory: TestDatabaseExpectation;
  readonly enums: EnumExpectation;
  /** supported のとき、DB 固有の定義は0件を期待する（migration の SQL にないことを確かめた） */
  readonly dbSpecific: DbSpecificExpectation;
};

/**
 * `/* … *\/`（Prisma が先頭に書く Warnings など。入れ子は扱わない）と `--` の行コメントを除く。
 * 文字列の中のコメント記号は考えない（enum の値・識別子に現れないことを前提にし、外れたら照合が失敗する側に倒れる）。
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** 文に分ける。閉じていないブロックコメントが残れば undefined（推測しない） */
function statementsOf(sql: string): string[] | undefined {
  const stripped = stripComments(sql);
  if (stripped.includes("/*") || stripped.includes("*/")) return undefined;
  return stripped
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
}

const IDENT = String.raw`(?:"public"\.|public\.)?(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const LABEL = String.raw`'((?:[^']|'')*)'`;

function identifierOf(quoted: string | undefined, bare: string | undefined): string {
  return quoted !== undefined ? quoted.replace(/""/g, '"') : (bare as string).toLowerCase();
}

const labelOf = (raw: string) => raw.replace(/''/g, "'");

/** `'a', 'b'` を値の配列にする。形が違えば undefined */
function parseLabelList(list: string): string[] | undefined {
  const labels: string[] = [];
  const re = new RegExp(String.raw`^\s*${LABEL}\s*(,|$)`);
  let rest = list;
  while (rest.trim() !== "") {
    const m = re.exec(rest);
    if (!m) return undefined;
    labels.push(labelOf(m[1]));
    rest = rest.slice(m[0].length);
  }
  return labels;
}

/** schema.prisma の enum の値（並びのまま）。属性・ブロックコメントなど、値として読めない行があれば例外 */
export function enumValuesFromSchema(schemaSource: string): Record<string, string[]> {
  assertSupportedSchema(schemaSource);
  const result: Record<string, string[]> = {};
  for (const m of schemaSource.matchAll(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/gm)) {
    const body = m[2];
    if (body.includes("/*")) throw new CatalogAuditError("EXPECTATION_INVALID", `enum ${m[1]} contains a block comment.`);
    const values = body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line !== "");
    if (values.some((value) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(value))) {
      throw new CatalogAuditError("EXPECTATION_INVALID", `enum ${m[1]} has a value line that is not a plain identifier.`);
    }
    result[m[1]] = values;
  }
  const names = enumNamesFromSchema(schemaSource);
  if (names.join("\n") !== Object.keys(result).sort().join("\n")) {
    throw new CatalogAuditError("EXPECTATION_INVALID", "the enum blocks of schema.prisma could not be read consistently.");
  }
  return result;
}

/**
 * migration の SQL を順に再現し、最後の enum の値と順序を返す（純粋関数）。
 * 対応していない形の TYPE の文があれば、推測せずに unsupported を返す。
 */
export function replayEnumsFromMigrations(migrations: readonly MigrationSource[]): EnumExpectation {
  const enums = new Map<string, string[]>();
  const reasons: string[] = [];
  const createEnum = new RegExp(String.raw`^CREATE TYPE ${IDENT} AS ENUM \((.*)\)$`, "is");
  const dropType = new RegExp(String.raw`^DROP TYPE (IF EXISTS )?${IDENT}( CASCADE| RESTRICT)?$`, "i");
  const addValue = new RegExp(String.raw`^ALTER TYPE ${IDENT} ADD VALUE (IF NOT EXISTS )?${LABEL}(?: (BEFORE|AFTER) ${LABEL})?$`, "i");
  const renameType = new RegExp(String.raw`^ALTER TYPE ${IDENT} RENAME TO ${IDENT}$`, "i");
  const renameValue = new RegExp(String.raw`^ALTER TYPE ${IDENT} RENAME VALUE ${LABEL} TO ${LABEL}$`, "i");

  for (const migration of migrations) {
    const statements = statementsOf(migration.sql);
    if (statements === undefined) {
      reasons.push(`${migration.name}: unbalanced block comment`);
      continue;
    }
    for (const statement of statements) {
      const where = `${migration.name}`;
      let m: RegExpExecArray | null;
      if ((m = createEnum.exec(statement))) {
        const name = identifierOf(m[1], m[2]);
        const labels = parseLabelList(m[3]);
        if (labels === undefined || enums.has(name) || new Set(labels).size !== labels.length) reasons.push(`${where}: unsupported CREATE TYPE for ${name}`);
        else enums.set(name, labels);
      } else if ((m = dropType.exec(statement))) {
        const name = identifierOf(m[2], m[3]);
        if (!enums.delete(name) && m[1] === undefined) reasons.push(`${where}: DROP TYPE of an unknown type ${name}`);
      } else if ((m = addValue.exec(statement))) {
        const name = identifierOf(m[1], m[2]);
        const values = enums.get(name);
        const label = labelOf(m[4]);
        if (values === undefined) {
          reasons.push(`${where}: ADD VALUE to an unknown enum ${name}`);
        } else if (values.includes(label)) {
          if (m[3] === undefined) reasons.push(`${where}: ADD VALUE of an existing value in ${name}`);
        } else if (m[5] === undefined) {
          values.push(label);
        } else {
          const anchor = values.indexOf(labelOf(m[6]));
          if (anchor < 0) reasons.push(`${where}: ADD VALUE relative to an unknown value in ${name}`);
          else values.splice(m[5].toUpperCase() === "BEFORE" ? anchor : anchor + 1, 0, label);
        }
      } else if ((m = renameType.exec(statement))) {
        const from = identifierOf(m[1], m[2]);
        const to = identifierOf(m[3], m[4]);
        const values = enums.get(from);
        if (values === undefined || enums.has(to)) reasons.push(`${where}: unsupported RENAME of type ${from}`);
        else {
          enums.delete(from);
          enums.set(to, values);
        }
      } else if ((m = renameValue.exec(statement))) {
        const name = identifierOf(m[1], m[2]);
        const values = enums.get(name);
        const index = values?.indexOf(labelOf(m[3])) ?? -1;
        if (values === undefined || index < 0 || values.includes(labelOf(m[4]))) reasons.push(`${where}: unsupported RENAME VALUE in ${name}`);
        else values[index] = labelOf(m[4]);
      } else if (/\b(CREATE|ALTER|DROP) TYPE\b/i.test(statement)) {
        reasons.push(`${where}: unsupported TYPE statement`);
      }
    }
  }
  if (reasons.length > 0) return { status: "unsupported", reasons };
  return { status: "supported", enums: Object.fromEntries([...enums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/** Prisma が作る単純なインデックス（列だけ。WHERE・式・INCLUDE なし）の形 */
const SIMPLE_INDEX = /^CREATE (UNIQUE )?INDEX "[^"]+" ON (?:"public"\.)?"[^"]+"(?: USING [a-z]+)? ?\( ?"[^"]+"(?: (?:ASC|DESC))?(?: ?, ?"[^"]+"(?: (?:ASC|DESC))?)* ?\)$/i;

const DB_SPECIFIC_PATTERNS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ["check constraint", /\bCHECK\s*\(/i],
  ["exclusion constraint", /\bEXCLUDE\b/i],
  ["row level security", /\bROW\s+LEVEL\s+SECURITY\b/i],
  ["policy", /\bCREATE\s+POLICY\b/i],
  ["trigger", /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i],
  ["routine", /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i],
  ["view", /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i],
  ["extension", /\bCREATE\s+EXTENSION\b/i],
];

/**
 * migration の SQL に、DB 固有の定義（Prisma の `migrate diff` の比較の外にあり得るもの）がないことを確かめる（純粋関数）。
 * 1つでもあれば unsupported（レビュー済みの期待値の仕組みは、必要になったときに別の工程で作る）。
 */
export function scanMigrationsForDbSpecificDefinitions(migrations: readonly MigrationSource[]): DbSpecificExpectation {
  const reasons: string[] = [];
  for (const migration of migrations) {
    const statements = statementsOf(migration.sql);
    if (statements === undefined) {
      reasons.push(`${migration.name}: unbalanced block comment`);
      continue;
    }
    for (const statement of statements) {
      for (const [kind, pattern] of DB_SPECIFIC_PATTERNS) if (pattern.test(statement)) reasons.push(`${migration.name}: ${kind}`);
      if (/^CREATE (UNIQUE )?INDEX\b/i.test(statement) && !SIMPLE_INDEX.test(statement)) reasons.push(`${migration.name}: index that is not a plain column index`);
    }
  }
  return reasons.length > 0 ? { status: "unsupported", reasons: [...new Set(reasons)].sort() } : { status: "supported" };
}

/** schema.prisma と migration の SQL から、期待値を作る（純粋関数。DB には触れない） */
export function buildCatalogAuditExpectation(input: { schemaSource: string; migrations: readonly MigrationSource[] }): CatalogAuditExpectation {
  const tables = applicationTablesFromSchema(input.schemaSource);
  const schemaEnums = enumValuesFromSchema(input.schemaSource);
  const replayed = replayEnumsFromMigrations(input.migrations);
  let enums: EnumExpectation = replayed;
  if (replayed.status === "supported") {
    // 値の集合が schema.prisma と食い違えば、どちらを期待値にすべきか決められないので、確定できないものとする
    const inconsistent = [...new Set([...Object.keys(schemaEnums), ...Object.keys(replayed.enums)])].filter((name) => {
      const a = schemaEnums[name];
      const b = replayed.enums[name];
      return a === undefined || b === undefined || [...a].sort().join("\n") !== [...b].sort().join("\n");
    });
    if (inconsistent.length > 0) enums = { status: "unsupported", reasons: inconsistent.map((name) => `enum ${name}: migrations and schema.prisma disagree`) };
  }
  return {
    inventory: { tables, enums: enumNamesFromSchema(input.schemaSource), migrations: input.migrations.map((m) => m.name) },
    enums,
    dbSpecific: scanMigrationsForDbSpecificDefinitions(input.migrations),
  };
}

/** リポジトリの prisma/schema.prisma と prisma/migrations を読んで期待値を作る（ファイルを読むだけ） */
export function loadCatalogAuditExpectation(root: string, readFile: (absolutePath: string) => string = (p) => readFileSync(p, "utf8")): CatalogAuditExpectation {
  const migrationsDir = path.join(root, "prisma", "migrations");
  const migrations = listMigrationNames(migrationsDir).map((name) => ({ name, sql: readFile(path.join(migrationsDir, name, "migration.sql")) }));
  return buildCatalogAuditExpectation({ schemaSource: readFile(path.join(root, "prisma", "schema.prisma")), migrations });
}

// ---- 行の検証 ----

type FieldKind = "text" | "nullableText" | "bool" | "int" | "number" | "textArray";

function invalid(step: string, detail: string): CatalogAuditError {
  return new CatalogAuditError("INVALID_CATALOG_RESULT", `${step}: ${detail}`);
}

function checkField(step: string, row: Record<string, unknown>, key: string, kind: FieldKind): unknown {
  const value = row[key];
  const ok =
    kind === "text"
      ? typeof value === "string"
      : kind === "nullableText"
        ? value === null || typeof value === "string"
        : kind === "bool"
          ? typeof value === "boolean"
          : kind === "int"
            ? Number.isInteger(value)
            : kind === "number"
              ? typeof value === "number" && Number.isFinite(value)
              : Array.isArray(value) && value.every((v) => typeof v === "string");
  if (!ok) throw invalid(step, `the column ${key} has an unexpected value type.`);
  return value;
}

/** 行を検証し、決めた列だけを決めた型で取り出す（読めない値を、ないもの・権限なしとは扱わない） */
function rowsOf<K extends string>(step: string, rows: readonly Record<string, unknown>[], spec: Readonly<Record<K, FieldKind>>): Record<K, unknown>[] {
  return rows.map((row) => {
    if (row === null || typeof row !== "object") throw invalid(step, "a row is not an object.");
    const out = {} as Record<K, unknown>;
    for (const key of Object.keys(spec) as K[]) out[key] = checkField(step, row, key, spec[key]);
    return out;
  });
}

// ---- A. 定義の検査（DB 固有の定義・enum） ----

export const DB_SPECIFIC_CONSTRAINTS_SQL = `SELECT c.relname AS "table", con.conname AS name, con.contype::text AS type
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND con.contype IN ('c', 'x', 't')`;

export const NON_PLAIN_INDEXES_SQL = `SELECT t.relname AS "table", i.relname AS name,
            (x.indpred IS NOT NULL) AS partial, (x.indexprs IS NOT NULL) AS expression
       FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND (x.indpred IS NOT NULL OR x.indexprs IS NOT NULL)`;

export const ROW_SECURITY_SQL = `SELECT c.relname AS "table", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND c.relkind IN ('r', 'p') AND (c.relrowsecurity OR c.relforcerowsecurity)`;

export const POLICIES_SQL = `SELECT c.relname AS "table", p.polname AS name
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}'`;

/** 並びは SQL の結果の順序に頼らず、enumsortorder で並べ直す */
export const ENUM_VALUES_SQL = `SELECT t.typname AS "enum", e.enumlabel AS value, e.enumsortorder AS "sortOrder"
       FROM pg_catalog.pg_enum e
       JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = '${APP_SCHEMA}'`;

export type DbSpecificDefinitions = {
  constraints: { table: string; name: string; type: string }[];
  indexes: { table: string; name: string; partial: boolean; expression: boolean }[];
  rowSecurity: { table: string; enabled: boolean; forced: boolean }[];
  policies: { table: string; name: string }[];
};

export async function readDbSpecificDefinitions(client: IntegrationDbClient): Promise<DbSpecificDefinitions> {
  const constraints = rowsOf("constraint listing", await select(client, "constraint listing", DB_SPECIFIC_CONSTRAINTS_SQL), {
    table: "text",
    name: "text",
    type: "text",
  });
  const indexes = rowsOf("index listing", await select(client, "index listing", NON_PLAIN_INDEXES_SQL), {
    table: "text",
    name: "text",
    partial: "bool",
    expression: "bool",
  });
  const rowSecurity = rowsOf("row security listing", await select(client, "row security listing", ROW_SECURITY_SQL), {
    table: "text",
    enabled: "bool",
    forced: "bool",
  });
  const policies = rowsOf("policy listing", await select(client, "policy listing", POLICIES_SQL), { table: "text", name: "text" });
  return {
    constraints: constraints as DbSpecificDefinitions["constraints"],
    indexes: indexes as DbSpecificDefinitions["indexes"],
    rowSecurity: rowSecurity as DbSpecificDefinitions["rowSecurity"],
    policies: policies as DbSpecificDefinitions["policies"],
  };
}

/** enum ごとの値（enumsortorder の昇順）。同じ順序の値が2つあれば不正な結果 */
export async function readEnumValues(client: IntegrationDbClient): Promise<Record<string, string[]>> {
  const rows = rowsOf("enum value listing", await select(client, "enum value listing", ENUM_VALUES_SQL), {
    enum: "text",
    value: "text",
    sortOrder: "number",
  }) as { enum: string; value: string; sortOrder: number }[];
  const byEnum = new Map<string, { value: string; sortOrder: number }[]>();
  for (const row of rows) byEnum.set(row.enum, [...(byEnum.get(row.enum) ?? []), row]);
  const result: Record<string, string[]> = {};
  for (const [name, values] of [...byEnum].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...values].sort((a, b) => a.sortOrder - b.sortOrder);
    if (new Set(sorted.map((v) => v.sortOrder)).size !== sorted.length) throw invalid("enum value listing", `enum ${name} has duplicate sort orders.`);
    if (new Set(sorted.map((v) => v.value)).size !== sorted.length) throw invalid("enum value listing", `enum ${name} has duplicate values.`);
    result[name] = sorted.map((v) => v.value);
  }
  return result;
}

const CONSTRAINT_KIND: Readonly<Record<string, string>> = { c: "check constraint", x: "exclusion constraint", t: "constraint trigger" };

/** enum の値と順序の照合（純粋関数）。名前の過不足は状態 C の判定でも確かめるが、ここでも値の照合のために扱う */
export function compareEnumValues(actual: Readonly<Record<string, readonly string[]>>, expected: Readonly<Record<string, readonly string[]>>): CatalogAuditFinding[] {
  const mismatched: string[] = [];
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const [name, values] of Object.entries(expected)) {
    const found = actual[name];
    if (found === undefined) missing.push(`enum ${name}`);
    else if (found.join("\n") !== values.join("\n")) {
      const sameSet = [...found].sort().join("\n") === [...values].sort().join("\n");
      mismatched.push(`enum ${name}: ${sameSet ? "order differs" : "values differ"}`);
    }
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) unexpected.push(`enum ${name}`);
  return [...finding("ENUM_MISMATCH", mismatched), ...finding("MISSING_OBJECT", missing), ...finding("UNEXPECTED_OBJECT", unexpected)];
}

/** DB 固有の定義と enum を、期待値と照合する（純粋関数） */
export function classifyCatalogDefinitions(
  input: { inventoryState: ReturnType<typeof classifyCatalogInventory>; dbSpecific: DbSpecificDefinitions; enumValues: Record<string, string[]> },
  expected: CatalogAuditExpectation,
): CatalogAuditReport {
  const findings: CatalogAuditFinding[] = [];
  // 状態 C の判定を再利用する（想定外のスキーマ・拡張・関数・ビュー・トリガー・ポリシーなど、テーブル・enum の過不足）
  if (input.inventoryState.state === "A") findings.push(...finding("MISSING_OBJECT", ["the database has no migrated objects (state A)"]));
  if (input.inventoryState.state === "B") {
    const reasons = input.inventoryState.reasons;
    findings.push(...finding("MISSING_OBJECT", reasons.filter((r) => r.startsWith("missing ") || r.includes(" is missing"))));
    findings.push(...finding("UNEXPECTED_OBJECT", reasons.filter((r) => !(r.startsWith("missing ") || r.includes(" is missing")))));
  }

  const dbSpecific = [
    ...input.dbSpecific.constraints.map((c) => `${c.table}.${c.name} (${CONSTRAINT_KIND[c.type] ?? `constraint type ${c.type}`})`),
    ...input.dbSpecific.indexes.map((i) => `${i.table}.${i.name} (${[i.partial ? "partial index" : "", i.expression ? "expression index" : ""].filter(Boolean).join(", ")})`),
    ...input.dbSpecific.rowSecurity.map((r) => `${r.table} (row level security${r.forced ? ", forced" : ""})`),
    ...input.dbSpecific.policies.map((p) => `${p.table}.${p.name} (policy)`),
  ];
  if (expected.dbSpecific.status === "supported") findings.push(...finding("UNEXPECTED_OBJECT", dbSpecific));
  else findings.push(...finding("EXPECTATION_UNSUPPORTED", expected.dbSpecific.reasons.map((r) => `database-specific definitions: ${r}`)));

  if (expected.enums.status === "supported") findings.push(...compareEnumValues(input.enumValues, expected.enums.enums));
  else findings.push(...finding("EXPECTATION_UNSUPPORTED", expected.enums.reasons.map((r) => `enum expectation: ${r}`)));
  return report(mergeFindings(findings));
}

function mergeFindings(findings: CatalogAuditFinding[]): CatalogAuditFinding[] {
  const byCategory = new Map<CatalogAuditCategory, string[]>();
  for (const f of findings) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), ...f.items]);
  return [...byCategory].flatMap(([category, items]) => finding(category, [...new Set(items)]));
}

/** 本人確認の後に、定義の検査に必要なカタログを読み、分類する（SELECT だけ） */
export async function auditCatalogDefinitions(client: IntegrationDbClient, expected: CatalogAuditExpectation): Promise<CatalogAuditReport> {
  const inventoryState = classifyCatalogInventory(await readCatalogInventory(client), expected.inventory);
  const dbSpecific = await readDbSpecificDefinitions(client);
  const enumValues = await readEnumValues(client);
  return classifyCatalogDefinitions({ inventoryState, dbSpecific, enumValues }, expected);
}

// ---- B. 読み取り専用ロールの検査（将来の katana_test_ro。今は偽のクライアントだけ） ----

export const ROLE_ATTRIBUTES_SQL = `SELECT current_user AS "currentUser", session_user AS "sessionUser",
            r.rolsuper AS superuser, r.rolinherit AS inherit, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDb",
            r.rolreplication AS replication, r.rolbypassrls AS "bypassRls",
            pg_catalog.current_setting('default_transaction_read_only') AS "defaultReadOnly"
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user`;

export const ROLE_MEMBERSHIPS_SQL = `SELECT pg_catalog.pg_get_userbyid(m.roleid) AS role
       FROM pg_catalog.pg_auth_members m
      WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)`;

export const ROLE_OWNERSHIP_SQL = `WITH me AS (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
     SELECT 'relation' AS kind, pg_catalog.count(*)::int AS count FROM pg_catalog.pg_class WHERE relowner = (SELECT oid FROM me)
     UNION ALL SELECT 'type', pg_catalog.count(*)::int FROM pg_catalog.pg_type WHERE typowner = (SELECT oid FROM me)
     UNION ALL SELECT 'schema', pg_catalog.count(*)::int FROM pg_catalog.pg_namespace WHERE nspowner = (SELECT oid FROM me)
     UNION ALL SELECT 'routine', pg_catalog.count(*)::int FROM pg_catalog.pg_proc WHERE proowner = (SELECT oid FROM me)
     UNION ALL SELECT 'database', pg_catalog.count(*)::int FROM pg_catalog.pg_database WHERE datdba = (SELECT oid FROM me)
     UNION ALL SELECT 'large object', pg_catalog.count(*)::int FROM pg_catalog.pg_largeobject_metadata WHERE lomowner = (SELECT oid FROM me)
     UNION ALL SELECT 'default privileges', pg_catalog.count(*)::int FROM pg_catalog.pg_default_acl WHERE defaclrole = (SELECT oid FROM me)`;

const ROLE_OWNERSHIP_KINDS = ["relation", "type", "schema", "routine", "database", "large object", "default privileges"];

export const ROLE_DATABASE_PRIVILEGES_SQL = `SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') AS "databaseCreate",
            pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY') AS "databaseTemporary",
            pg_catalog.has_schema_privilege('${APP_SCHEMA}', 'CREATE') AS "schemaCreate",
            pg_catalog.has_schema_privilege('${APP_SCHEMA}', 'USAGE') AS "schemaUsage"`;

/**
 * テーブルの権限（2引数の関数は current_user で評価する。呼び出し側は current_user = session_user = katana_test_ro を確かめる）。
 * - SELECT：テーブル単位だけを数える（has_table_privilege は列単位の権限を数えない。一部の列だけ見える状態を「見える」としない）。
 * - INSERT・UPDATE・REFERENCES：列単位の権限でも書き込み・参照ができるので、has_any_column_privilege
 *   （テーブル単位、または1列以上の列単位の権限があれば true）で数える。
 * - DELETE・TRUNCATE・TRIGGER：テーブル単位にしかない権限なので has_table_privilege。
 */
export const ROLE_TABLE_PRIVILEGES_SQL = `SELECT c.relname AS "table",
            pg_catalog.has_table_privilege(c.oid, 'SELECT') AS "select",
            pg_catalog.has_any_column_privilege(c.oid, 'INSERT') AS "insert",
            pg_catalog.has_any_column_privilege(c.oid, 'UPDATE') AS "update",
            pg_catalog.has_table_privilege(c.oid, 'DELETE') AS "delete",
            pg_catalog.has_table_privilege(c.oid, 'TRUNCATE') AS "truncate",
            pg_catalog.has_any_column_privilege(c.oid, 'REFERENCES') AS "references",
            pg_catalog.has_table_privilege(c.oid, 'TRIGGER') AS "trigger"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND c.relkind IN ('r', 'p')`;

export const ROLE_SEQUENCE_PRIVILEGES_SQL = `SELECT c.relname AS name,
            pg_catalog.has_sequence_privilege(c.oid, 'USAGE') AS "usage",
            pg_catalog.has_sequence_privilege(c.oid, 'UPDATE') AS "update"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND c.relkind = 'S'`;

/** カタログ（権限に関係なく見える）の列。information_schema.columns が扱う種類（r・p・v・f）に合わせる */
export const CATALOG_COLUMNS_SQL = `SELECT c.relname AS "table", a.attname AS "column"
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${APP_SCHEMA}' AND c.relkind IN ('r', 'p', 'v', 'f') AND a.attnum > 0 AND NOT a.attisdropped`;

/** 接続しているロールから見える列（Prisma の schema engine は列をここから読む。権限のない列は現れない） */
export const VISIBLE_COLUMNS_SQL = `SELECT info.table_name AS "table", info.column_name AS "column"
       FROM information_schema.columns info
      WHERE info.table_schema = '${APP_SCHEMA}'`;

export type ReadOnlyRoleSnapshot = {
  role: {
    currentUser: string;
    sessionUser: string;
    superuser: boolean;
    inherit: boolean;
    createRole: boolean;
    createDb: boolean;
    replication: boolean;
    bypassRls: boolean;
    defaultReadOnly: string;
  };
  memberships: string[];
  ownership: { kind: string; count: number }[];
  database: { databaseCreate: boolean; databaseTemporary: boolean; schemaCreate: boolean; schemaUsage: boolean };
  tables: { table: string; select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean; references: boolean; trigger: boolean }[];
  sequences: { name: string; usage: boolean; update: boolean }[];
  catalogColumns: { table: string; column: string }[];
  visibleColumns: { table: string; column: string }[];
};

/** 読み取り専用ロールで接続した後（本人確認・サーバーの識別の後）に、権限と可視性を読む（SELECT だけ） */
export async function readReadOnlyRoleSnapshot(client: IntegrationDbClient): Promise<ReadOnlyRoleSnapshot> {
  const roleRows = rowsOf("role attributes", await select(client, "role attributes", ROLE_ATTRIBUTES_SQL), {
    currentUser: "text",
    sessionUser: "text",
    superuser: "bool",
    inherit: "bool",
    createRole: "bool",
    createDb: "bool",
    replication: "bool",
    bypassRls: "bool",
    defaultReadOnly: "text",
  });
  if (roleRows.length !== 1) throw invalid("role attributes", "expected exactly one row.");
  const memberships = rowsOf("role memberships", await select(client, "role memberships", ROLE_MEMBERSHIPS_SQL), { role: "text" });
  const ownership = rowsOf("role ownership", await select(client, "role ownership", ROLE_OWNERSHIP_SQL), { kind: "text", count: "int" }) as {
    kind: string;
    count: number;
  }[];
  // 種類が欠けていれば、0件と読み替えない
  if (ownership.map((o) => o.kind).sort().join("\n") !== [...ROLE_OWNERSHIP_KINDS].sort().join("\n")) {
    throw invalid("role ownership", "the ownership kinds are incomplete.");
  }
  const databaseRows = rowsOf("role database privileges", await select(client, "role database privileges", ROLE_DATABASE_PRIVILEGES_SQL), {
    databaseCreate: "bool",
    databaseTemporary: "bool",
    schemaCreate: "bool",
    schemaUsage: "bool",
  });
  if (databaseRows.length !== 1) throw invalid("role database privileges", "expected exactly one row.");
  const tables = rowsOf("role table privileges", await select(client, "role table privileges", ROLE_TABLE_PRIVILEGES_SQL), {
    table: "text",
    select: "bool",
    insert: "bool",
    update: "bool",
    delete: "bool",
    truncate: "bool",
    references: "bool",
    trigger: "bool",
  });
  const sequences = rowsOf("role sequence privileges", await select(client, "role sequence privileges", ROLE_SEQUENCE_PRIVILEGES_SQL), {
    name: "text",
    usage: "bool",
    update: "bool",
  });
  const columnSpec = { table: "text", column: "text" } as const;
  const catalogColumns = rowsOf("catalog columns", await select(client, "catalog columns", CATALOG_COLUMNS_SQL), columnSpec);
  const visibleColumns = rowsOf("visible columns", await select(client, "visible columns", VISIBLE_COLUMNS_SQL), columnSpec);
  return {
    role: roleRows[0] as ReadOnlyRoleSnapshot["role"],
    memberships: memberships.map((m) => m.role as string),
    ownership,
    database: databaseRows[0] as ReadOnlyRoleSnapshot["database"],
    tables: tables as ReadOnlyRoleSnapshot["tables"],
    sequences: sequences as ReadOnlyRoleSnapshot["sequences"],
    catalogColumns: catalogColumns as ReadOnlyRoleSnapshot["catalogColumns"],
    visibleColumns: visibleColumns as ReadOnlyRoleSnapshot["visibleColumns"],
  };
}

/** 権限・可視性を判定する対象のロール（固定。ほかのロールの権限は判定しない） */
export const READ_ONLY_ROLE = "katana_test_ro";

export type ReadOnlyRoleExpectation = {
  /** 接続しているロールの名前（current_user・session_user の期待値。READ_ONLY_ROLE に固定） */
  readonly role: typeof READ_ONLY_ROLE;
  /**
   * SELECT が必要で、書き込みの権限があってはならないテーブル（schema.prisma のテーブル + `_prisma_migrations`）。
   * `_prisma_migrations` は、Prisma の schema engine が読むかは未確認だが、public のテーブルとして見える必要がある側に含める（読むだけ）。
   */
  readonly tables: readonly string[];
};

export function readOnlyRoleExpectation(expected: CatalogAuditExpectation): ReadOnlyRoleExpectation {
  return { role: READ_ONLY_ROLE, tables: [...new Set([...expected.inventory.tables, MIGRATIONS_TABLE])].sort() };
}

const WRITE_PRIVILEGES = ["insert", "update", "delete", "truncate", "references", "trigger"] as const;
const ROLE_ATTRIBUTES = ["superuser", "inherit", "createRole", "createDb", "replication", "bypassRls"] as const;

/**
 * 読み取り専用ロールの権限と可視性を判定する（純粋関数）。
 * 列は「テーブル名・列名」の集合で比べる（件数だけでは比べない）。期待するテーブルがすべて、SELECT 付きで見えることも求める。
 */
export function classifyReadOnlyRoleSnapshot(snapshot: ReadOnlyRoleSnapshot, expected: ReadOnlyRoleExpectation): CatalogAuditReport {
  // 判定の対象は READ_ONLY_ROLE だけ（期待値が別のロールを指していても、接続が別のロールでも判定しない）
  if (expected.role !== READ_ONLY_ROLE || snapshot.role.currentUser !== READ_ONLY_ROLE || snapshot.role.sessionUser !== READ_ONLY_ROLE) {
    throw new CatalogAuditError("IDENTITY_CHECK_FAILED", `current_user and session_user must both be ${READ_ONLY_ROLE}.`);
  }
  const violations: string[] = [];
  for (const attribute of ROLE_ATTRIBUTES) if (snapshot.role[attribute]) violations.push(`role attribute ${attribute}`);
  if (snapshot.role.defaultReadOnly !== "on") violations.push("default_transaction_read_only is not on");
  for (const role of snapshot.memberships) violations.push(`member of role ${role}`);
  for (const o of snapshot.ownership) if (o.count !== 0) violations.push(`owns ${o.kind} (${o.count})`);
  if (snapshot.database.databaseCreate) violations.push("database CREATE");
  if (snapshot.database.databaseTemporary) violations.push("database TEMPORARY");
  if (snapshot.database.schemaCreate) violations.push(`schema ${APP_SCHEMA} CREATE`);
  for (const t of snapshot.tables) for (const p of WRITE_PRIVILEGES) if (t[p]) violations.push(`${t.table} ${p.toUpperCase()}`);
  for (const s of snapshot.sequences) {
    if (s.usage) violations.push(`sequence ${s.name} USAGE`);
    if (s.update) violations.push(`sequence ${s.name} UPDATE`);
  }

  const insufficient: string[] = [];
  if (!snapshot.database.schemaUsage) insufficient.push(`schema ${APP_SCHEMA} USAGE`);
  const privilegeTables = new Map(snapshot.tables.map((t) => [t.table, t]));
  for (const t of snapshot.tables) if (!t.select) insufficient.push(`${t.table}: no table-level SELECT`);
  const key = (c: { table: string; column: string }) => `${c.table}.${c.column}`;
  const catalog = new Set(snapshot.catalogColumns.map(key));
  const visible = new Set(snapshot.visibleColumns.map(key));
  for (const c of [...catalog].filter((k) => !visible.has(k))) insufficient.push(`${c}: not visible in information_schema.columns`);
  for (const c of [...visible].filter((k) => !catalog.has(k))) insufficient.push(`${c}: visible but not found in pg_attribute`);
  const catalogTables = new Set(snapshot.catalogColumns.map((c) => c.table));

  const missing = expected.tables.filter((t) => !privilegeTables.has(t) || !catalogTables.has(t)).map((t) => `table ${t}`);
  const unexpected = snapshot.tables.map((t) => t.table).filter((t) => !expected.tables.includes(t)).map((t) => `table ${t}`);
  return report([
    ...finding("READ_ONLY_ROLE_PRIVILEGE_VIOLATION", violations),
    ...finding("COLUMN_VISIBILITY_INSUFFICIENT", insufficient),
    ...finding("MISSING_OBJECT", missing),
    ...finding("UNEXPECTED_OBJECT", unexpected),
  ]);
}

// ---- C. カタログの fingerprint ----

/**
 * fingerprint の対象（セクションごとに、行の列・型・項目のキー）。OID・行の内容（データ）・統計・sequence の現在値は含めない。
 * ACL・所有者・ロールの設定は名前で表す（aclitem の文字列はロール名を使う）。
 */
type SectionSpec = { readonly sql: string; readonly fields: Readonly<Record<string, FieldKind>>; readonly key: readonly string[] };

const NON_SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

export const CATALOG_FINGERPRINT_SECTIONS: Readonly<Record<string, SectionSpec>> = {
  database: {
    sql: `SELECT d.datname AS name, pg_catalog.pg_get_userbyid(d.datdba) AS owner, d.datacl::text AS acl,
            pg_catalog.shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`,
    fields: { name: "text", owner: "text", acl: "nullableText", comment: "nullableText" },
    key: ["name"],
  },
  schemas: {
    sql: `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner, n.nspacl::text AS acl
       FROM pg_catalog.pg_namespace n WHERE ${NON_SYSTEM}`,
    fields: { name: "text", owner: "text", acl: "nullableText" },
    key: ["name"],
  },
  extensions: {
    sql: `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
       FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace`,
    fields: { name: "text", version: "text", schema: "text" },
    key: ["name"],
  },
  relations: {
    sql: `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.relpersistence::text AS persistence,
            c.relrowsecurity AS "rowSecurity", c.relforcerowsecurity AS "forceRowSecurity",
            pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", name: "text", kind: "text", persistence: "text", rowSecurity: "bool", forceRowSecurity: "bool", owner: "text", acl: "nullableText" },
    key: ["schema", "name"],
  },
  columns: {
    sql: `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name, a.attnum::int AS position,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity::text AS identity, a.attgenerated::text AS generated,
            co.collname AS collation, a.attacl::text AS acl
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
      WHERE ${NON_SYSTEM} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped`,
    fields: {
      schema: "text",
      table: "text",
      name: "text",
      position: "int",
      type: "text",
      notNull: "bool",
      default: "nullableText",
      identity: "text",
      generated: "text",
      collation: "nullableText",
      acl: "nullableText",
    },
    key: ["schema", "table", "name"],
  },
  constraints: {
    sql: `SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name, con.contype::text AS type,
            pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
            con.condeferrable AS deferrable, con.condeferred AS deferred, con.convalidated AS validated
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", table: "text", name: "text", type: "text", definition: "text", deferrable: "bool", deferred: "bool", validated: "bool" },
    key: ["schema", "table", "name"],
  },
  indexes: {
    sql: `SELECT n.nspname AS schema, i.relname AS name, t.relname AS "table", pg_catalog.pg_get_indexdef(x.indexrelid) AS definition,
            x.indisprimary AS "primary", x.indisunique AS "unique", x.indisvalid AS valid
       FROM pg_catalog.pg_index x
       JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
       JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", name: "text", table: "text", definition: "text", primary: "bool", unique: "bool", valid: "bool" },
    key: ["schema", "name"],
  },
  types: {
    sql: `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind, pg_catalog.pg_get_userbyid(t.typowner) AS owner, t.typacl::text AS acl
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", name: "text", kind: "text", owner: "text", acl: "nullableText" },
    key: ["schema", "name"],
  },
  enumValues: {
    sql: `SELECT n.nspname AS schema, t.typname AS "enum", e.enumlabel AS value,
            pg_catalog.row_number() OVER (PARTITION BY e.enumtypid ORDER BY e.enumsortorder)::int AS position
       FROM pg_catalog.pg_enum e
       JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", enum: "text", value: "text", position: "int" },
    key: ["schema", "enum", "value"],
  },
  sequences: {
    sql: `SELECT n.nspname AS schema, c.relname AS name, pg_catalog.format_type(s.seqtypid, NULL) AS type,
            s.seqstart::text AS start, s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max,
            s.seqcache::text AS cache, s.seqcycle AS cycle
       FROM pg_catalog.pg_sequence s
       JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", name: "text", type: "text", start: "text", increment: "text", min: "text", max: "text", cache: "text", cycle: "bool" },
    key: ["schema", "name"],
  },
  routines: {
    sql: `SELECT n.nspname AS schema, p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
            p.prokind::text AS kind, p.prosecdef AS "securityDefiner", pg_catalog.md5(p.prosrc) AS "sourceHash",
            pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", name: "text", arguments: "text", kind: "text", securityDefiner: "bool", sourceHash: "text", owner: "text", acl: "nullableText" },
    key: ["schema", "name", "arguments"],
  },
  triggers: {
    sql: `SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
            t.tgenabled::text AS enabled
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM} AND NOT t.tgisinternal`,
    fields: { schema: "text", table: "text", name: "text", definition: "text", enabled: "text" },
    key: ["schema", "table", "name"],
  },
  policies: {
    sql: `SELECT n.nspname AS schema, c.relname AS "table", p.polname AS name, p.polcmd::text AS command, p.polpermissive AS permissive,
            pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.pg_get_userbyid(r) FROM pg_catalog.unnest(p.polroles) AS r ORDER BY 1), ',') AS roles,
            pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS "using", pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS "withCheck"
       FROM pg_catalog.pg_policy p
       JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM}`,
    fields: { schema: "text", table: "text", name: "text", command: "text", permissive: "bool", roles: "text", using: "nullableText", withCheck: "nullableText" },
    key: ["schema", "table", "name"],
  },
  defaultPrivileges: {
    sql: `SELECT pg_catalog.pg_get_userbyid(a.defaclrole) AS role, COALESCE(n.nspname, '') AS schema, a.defaclobjtype::text AS "objectType",
            a.defaclacl::text AS acl
       FROM pg_catalog.pg_default_acl a LEFT JOIN pg_catalog.pg_namespace n ON n.oid = a.defaclnamespace`,
    fields: { role: "text", schema: "text", objectType: "text", acl: "text" },
    key: ["role", "schema", "objectType"],
  },
  roles: {
    // config：ロール全体の設定（pg_roles.rolconfig。pg_db_role_setting の setdatabase = 0 の行）。値は md5 にしてから読む
    sql: `SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolinherit AS inherit, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDb",
            r.rolcanlogin AS login, r.rolreplication AS replication, r.rolbypassrls AS "bypassRls", r.rolconnlimit AS "connectionLimit",
            pg_catalog.md5(r.rolconfig::text) AS config
       FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_'`,
    fields: {
      name: "text",
      superuser: "bool",
      inherit: "bool",
      createRole: "bool",
      createDb: "bool",
      login: "bool",
      replication: "bool",
      bypassRls: "bool",
      connectionLimit: "int",
      config: "nullableText",
    },
    key: ["name"],
  },
  /**
   * pg_db_role_setting のすべての行（ALTER ROLE … SET・ALTER ROLE … IN DATABASE … SET・ALTER DATABASE … SET・ALTER ROLE ALL …）。
   * setdatabase = 0 は全DB、setrole = 0 は全ロールに適用される設定。LEFT JOIN で、0 の行を落とさない。
   * 0 でないのに名前を引けない行は、名前が NULL になり、不正な結果として拒否される（OID の値では表さない）。
   * 設定値（setconfig）は秘密情報を含み得るので、DB の中で md5 にしてから読む（生の値は読まない・表示しない）。
   */
  dbRoleSettings: {
    sql: `SELECT CASE WHEN s.setdatabase = 0 THEN 'all' ELSE 'one' END AS "databaseScope",
            CASE WHEN s.setdatabase = 0 THEN '' ELSE d.datname END AS database,
            CASE WHEN s.setrole = 0 THEN 'all' ELSE 'one' END AS "roleScope",
            CASE WHEN s.setrole = 0 THEN '' ELSE r.rolname END AS role,
            pg_catalog.md5(s.setconfig::text) AS "configHash"
       FROM pg_catalog.pg_db_role_setting s
       LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole`,
    fields: { databaseScope: "text", database: "text", roleScope: "text", role: "text", configHash: "text" },
    key: ["databaseScope", "database", "roleScope", "role"],
  },
  roleMemberships: {
    sql: `SELECT pg_catalog.pg_get_userbyid(m.roleid) AS role, pg_catalog.pg_get_userbyid(m.member) AS member, m.admin_option AS admin
       FROM pg_catalog.pg_auth_members m`,
    fields: { role: "text", member: "text", admin: "bool" },
    key: ["role", "member"],
  },
  largeObjects: {
    sql: `SELECT pg_catalog.pg_get_userbyid(l.lomowner) AS owner, pg_catalog.count(*)::int AS count
       FROM pg_catalog.pg_largeobject_metadata l GROUP BY l.lomowner`,
    fields: { owner: "text", count: "int" },
    key: ["owner"],
  },
};

/**
 * 2回の観測の間で、DB の定義が変わっていないことを比べるための値。**Prisma schema との一致を示すものではない。**
 * sections は、セクションごとに「キー → 正規化した行」を、キーの順に並べたもの。
 */
export type CatalogFingerprint = {
  readonly meaning: "observed-catalog-definition";
  readonly sha256: string;
  readonly sections: Readonly<Record<string, readonly (readonly [key: string, row: string])[]>>;
};

/** カタログの行から fingerprint を作る（純粋関数）。結果の順序に依存しない。キーの重複・不正な型は拒否する */
export function buildCatalogFingerprint(rowsBySection: Readonly<Record<string, readonly Record<string, unknown>[]>>): CatalogFingerprint {
  const sections: Record<string, (readonly [string, string])[]> = {};
  const hash = createHash("sha256");
  for (const name of Object.keys(CATALOG_FINGERPRINT_SECTIONS).sort()) {
    const spec = CATALOG_FINGERPRINT_SECTIONS[name];
    const rows = rowsBySection[name];
    if (rows === undefined) throw invalid(`fingerprint ${name}`, "the section was not read.");
    const fields = Object.keys(spec.fields).sort();
    const entries = rowsOf(`fingerprint ${name}`, rows, spec.fields).map((row) => {
      const key = JSON.stringify(spec.key.map((k) => row[k]));
      return [key, JSON.stringify(fields.map((f) => [f, row[f]]))] as const;
    });
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i][0] === entries[i - 1][0]) throw invalid(`fingerprint ${name}`, "duplicate keys were read.");
    }
    sections[name] = entries;
    hash.update(`${name}\n`);
    for (const [key, row] of entries) hash.update(`${key}\t${row}\n`);
  }
  return { meaning: "observed-catalog-definition", sha256: hash.digest("hex"), sections };
}

/** 本人確認の後に、fingerprint の対象のカタログを読む（SELECT だけ） */
export async function readCatalogFingerprint(client: IntegrationDbClient): Promise<CatalogFingerprint> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const name of Object.keys(CATALOG_FINGERPRINT_SECTIONS).sort()) {
    rows[name] = await select(client, `fingerprint ${name}`, CATALOG_FINGERPRINT_SECTIONS[name].sql);
  }
  return buildCatalogFingerprint(rows);
}

export type CatalogFingerprintChange = { readonly section: string; readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };

/** 前後の fingerprint の差（項目のキーだけを返す。定義の文字列は返さない） */
export function compareCatalogFingerprints(before: CatalogFingerprint, after: CatalogFingerprint): { unchanged: boolean; changes: CatalogFingerprintChange[] } {
  const changes: CatalogFingerprintChange[] = [];
  for (const section of [...new Set([...Object.keys(before.sections), ...Object.keys(after.sections)])].sort()) {
    const a = new Map(before.sections[section] ?? []);
    const b = new Map(after.sections[section] ?? []);
    const added = [...b.keys()].filter((k) => !a.has(k));
    const removed = [...a.keys()].filter((k) => !b.has(k));
    const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
    if (added.length + removed.length + changed.length > 0) changes.push({ section, added, removed, changed });
  }
  return { unchanged: changes.length === 0 && before.sha256 === after.sha256, changes };
}

/** 前後で一致しなければ、セクションと件数だけを含む FINGERPRINT_MISMATCH を投げる */
export function assertCatalogFingerprintUnchanged(before: CatalogFingerprint, after: CatalogFingerprint): void {
  const { unchanged, changes } = compareCatalogFingerprints(before, after);
  if (unchanged) return;
  const detail = changes.map((c) => `${c.section} (added ${c.added.length}, removed ${c.removed.length}, changed ${c.changed.length})`).join("; ");
  throw new CatalogAuditError("FINGERPRINT_MISMATCH", `the catalog definition changed between the two observations: ${detail || "hash differs"}.`);
}

// ---- 実行（スクリプトには未接続） ----

export type CatalogDefinitionAuditInput = {
  /** `.env.test` の検証済みの接続URL */
  databaseUrl: string;
  /** `.env` の開発用DBの接続URL（同じ接続先でないことの確認にだけ使う） */
  developmentDatabaseUrl: string | undefined;
  /** 検証済みの接続URLで1回だけ接続する（lib/testing/testDbConnection.ts の connectTestDatabase を渡す想定） */
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
  expectation: CatalogAuditExpectation;
  /** D1・F1 で確かめた識別情報。この接続のサーバーが合わなければ、カタログを読まずに止まる */
  expectedServer: PinnedServerExpectation;
};

export type CatalogDefinitionAuditResult = { readonly report: CatalogAuditReport; readonly fingerprint: CatalogFingerprint };

const IDENTITY_CODES = new Set(["NOT_READ_ONLY", "DATABASE_MISMATCH", "CURRENT_USER_MISMATCH", "SESSION_USER_MISMATCH", "MARKER_MISMATCH", "IDENTITY_UNAVAILABLE"]);

/**
 * 表示してよい失敗の内容。IntegrationDatabaseCheckError のメッセージは、もともとコード・手順の名前・SQLSTATE だけで作られている
 * （select・runReadOnlyCheck が safeErrorCode で作る）ので、接頭辞だけを除いて使う。それ以外は、コードの形の値だけを使う。
 */
function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError) return error.message.replace(/^\[integrationDatabaseCheck\] /, "");
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown";
}

/**
 * katana_test_user の読み取り専用の接続で、定義の検査と fingerprint の読み取りを行う（DB は変更しない）。
 * 失敗しても ROLLBACK・接続の解放を行い（runReadOnlyCheck）、コードだけを含む CatalogAuditError を投げる。
 */
export async function runCatalogDefinitionAudit(input: CatalogDefinitionAuditInput): Promise<CatalogDefinitionAuditResult> {
  try {
    assertTestDatabaseTarget({ databaseUrl: input.databaseUrl, env: {}, developmentDatabaseUrl: input.developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new CatalogAuditError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    throw error;
  }
  let settled = false;
  try {
    return await runReadOnlyCheck(input.connect, input.databaseUrl, async (client) => {
      try {
        try {
          await pinSearchPath(client);
          await assertDatabaseIdentity(client); // transaction_read_only=on と本人確認
        } catch (error) {
          if (error instanceof IntegrationDatabaseCheckError && IDENTITY_CODES.has(error.code)) {
            throw new CatalogAuditError("IDENTITY_CHECK_FAILED", `the database identity check failed (${error.code}).`);
          }
          throw error;
        }
        let server: Awaited<ReturnType<typeof readServerIdentity>>;
        try {
          server = await readServerIdentity(client);
        } catch (error) {
          if (error instanceof IntegrationDatabaseCheckError && error.code === "SERVER_IDENTITY_UNAVAILABLE") {
            throw new CatalogAuditError("SERVER_IDENTITY_MISMATCH", "the server identity could not be read; the catalog was not read.");
          }
          throw error;
        }
        const mismatches = pinnedServerMismatches(server, input.expectedServer);
        if (mismatches.length > 0) {
          throw new CatalogAuditError("SERVER_IDENTITY_MISMATCH", `this connection does not reach the verified server (${mismatches.join(", ")}); the catalog was not read.`);
        }
        const auditReport = await auditCatalogDefinitions(client, input.expectation);
        const fingerprint = await readCatalogFingerprint(client);
        return { report: auditReport, fingerprint };
      } catch (error) {
        if (error instanceof CatalogAuditError) throw error;
        throw new CatalogAuditError("CATALOG_QUERY_FAILED", `the catalog could not be read (${codeOf(error)}).`);
      } finally {
        settled = true;
      }
    });
  } catch (error) {
    if (error instanceof CatalogAuditError) throw error;
    if (error instanceof IntegrationDatabaseCheckError && error.code === "CONNECT_FAILED") {
      throw new CatalogAuditError("CONNECT_FAILED", "could not connect to the test database.");
    }
    // 検査の後の ROLLBACK・接続の解放の失敗（検査そのものが成功していても、成功とは扱わない）
    if (settled || (error instanceof IntegrationDatabaseCheckError && error.code === "CLOSE_FAILED")) {
      throw new CatalogAuditError("TRANSACTION_CLOSE_FAILED", `ROLLBACK or closing the connection failed (${codeOf(error)}).`);
    }
    throw new CatalogAuditError("CATALOG_QUERY_FAILED", `the read-only transaction could not be started (${codeOf(error)}).`);
  }
}
