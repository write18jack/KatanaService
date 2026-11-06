import { assertTestDatabaseTarget, TestDatabaseGuardError } from "../db/testDatabaseGuard.ts";
import {
  assertDatabaseIdentity,
  assertSupportedSchema,
  compareMigrationHistory,
  findNonEmptyTables,
  IntegrationDatabaseCheckError,
  type IntegrationDbClient,
  MIGRATIONS_TABLE,
  quoteIdentifier,
  readMigrationHistory,
  runReadOnlyCheck,
  select,
} from "./integrationDatabaseCheck.ts";

/**
 * テストDBの migration の前後の状態を、読み取り専用で次の3つに分ける（Step 3-10B）。
 *
 * - A：migration を1件も適用していない、完全に空のDB
 * - B：途中まで適用した・失敗した・想定外のものがあるDB（AにもCにも当たらないものすべて）
 * - C：期待する migration をすべて正常に適用し、アプリのテーブルが空のDB
 *
 * 状態を判定するだけで、migration・reset・DROP・TRUNCATE・DELETE・自動復旧は行わない。どの状態でも、DBを変更しない。
 * 判定の結果をどう扱うか（A なら migrate deploy、C なら何もしない、B なら拒否）は、呼び出し側が決める。
 * 現時点では、どこからも呼ばない（testdb-migrate への組み込みは別工程）。
 *
 * 実行順序（途中で失敗したら、その時点で止める）:
 * 1. 期待値と接続URLの検証（接続しない）  2. 接続（1回だけ。接続は呼び出し側が `connect` として渡す）
 * 3. `BEGIN READ ONLY` の後、search_path を、このトランザクションの中だけ `pg_catalog` に固定する（下記）
 * 4. 本人確認（失敗したら throw し、状態の判定に進まない）
 * 5. カタログの一覧の取得  6. 状態の判定（C の候補のときだけ、migration の履歴と空DB検査を読む）
 * 7. 成功・失敗にかかわらず ROLLBACK して接続を閉じる。
 *
 * 検査そのものが失敗した場合（SQLのエラー・接続の失敗・本人確認の失敗）は、状態 B とは扱わず、例外を投げる（fail-closed）。
 *
 * search_path：カタログ・public のテーブルはスキーマで修飾しているが、関数（current_database()・count など）と演算子（=・LIKE など）は
 * search_path で解決される。ロール・DBの設定で `public, pg_catalog` のように pg_catalog を後ろに置かれると、public の同名の関数・演算子が
 * 先に使われ得る。そのため、最初に `pg_catalog.set_config('search_path', 'pg_catalog', true)`（トランザクションの中だけ有効で、
 * ROLLBACK で元に戻る。DBは変更しない）を実行し、戻り値が `pg_catalog` であることを確かめてから検査する。
 * 一時スキーマ（pg_temp）は、リレーションの解決では常に先に探されるが、検査の SQL はリレーションをすべてスキーマで修飾している。
 *
 * C の限界: 列・型の中身・インデックスの定義・制約が schema.prisma と一致することは保証しない
 * （Step 3-12 の `prisma migrate diff` で照合する。まだ実施していない）。
 *
 * 権限（Step 3-11D）：inspectTestDatabase は、同じ読み取り専用のトランザクションの中で、本人確認の後に
 * migration に必要な権限（public の USAGE・CREATE、DBの所有者、DBの CREATE）も読む。権限は状態 A・B・C とは別の結果で、
 * 権限が足りなくても状態の判定は変わらない（B にはしない）。不足をどう扱うかは、呼び出し側が決める。
 *
 * 例外・判定の理由には、接続URL・パスワード・ドライバの元のエラーメッセージを含めない（SQLSTATE などのコードと、オブジェクトの名前だけ）。
 */

const APP_SCHEMA = "public";
/** migration 前から存在してよい拡張（PostgreSQL の標準。pg_catalog に置かれる） */
const ALLOWED_EXTENSIONS = new Set(["plpgsql"]);
/** PostgreSQL の FirstNormalObjectId。これ未満の OID は initdb が作ったシステムのオブジェクト */
const FIRST_NORMAL_OBJECT_ID = 16384;
/** 判定の理由に並べるオブジェクトの上限（多すぎるときは件数だけを示す） */
const MAX_LISTED = 20;

/** システムのスキーマ（pg_catalog・information_schema・pg_toast*・pg_temp_*）を除く条件 */
const NON_SYSTEM_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

/** スキーマ（システムのものを除く） */
const SCHEMAS_SQL = `SELECT n.nspname AS name
       FROM pg_catalog.pg_namespace n
      WHERE ${NON_SYSTEM_SCHEMA}`;

/** 拡張（plpgsql を含むすべて） */
const EXTENSIONS_SQL = `SELECT e.extname AS name FROM pg_catalog.pg_extension e`;

/**
 * リレーション（テーブル・ビュー・マテリアライズドビュー・外部テーブル・シーケンス・インデックスなど）。
 * インデックスは対象のテーブルを、シーケンスは所有するテーブル（SERIAL・IDENTITY の列）を一緒に返す。
 * 独立した複合型（relkind 'c'）は、型の一覧の側で1回だけ数える。
 */
const RELATIONS_SQL = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
            COALESCE(itn.nspname, stn.nspname) AS "ownerSchema", COALESCE(it.relname, st.relname) AS "ownerTable"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
       LEFT JOIN pg_catalog.pg_class it ON it.oid = i.indrelid
       LEFT JOIN pg_catalog.pg_namespace itn ON itn.oid = it.relnamespace
       LEFT JOIN pg_catalog.pg_depend d
              ON c.relkind = 'S'
             AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND d.objid = c.oid
             AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND d.deptype IN ('a', 'i')
       LEFT JOIN pg_catalog.pg_class st ON st.oid = d.refobjid
       LEFT JOIN pg_catalog.pg_namespace stn ON stn.oid = st.relnamespace
      WHERE c.relkind <> 'c'
        AND ${NON_SYSTEM_SCHEMA}`;

/**
 * ユーザー定義の型（enum・domain・複合型・range・multirange・基本型など）。
 * 暗黙に作られる型は二重に数えない: テーブル・ビューなどの行型（リレーションの側で数える）と、
 * 型ごとに自動で作られる配列型（元の型の側で数える）は除く。range 型と、自動で作られる multirange 型は、別々に数える。
 */
const TYPES_SQL = `SELECT n.nspname AS schema, t.typname AS name, t.typtype AS kind
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE ${NON_SYSTEM_SCHEMA}
        AND NOT (t.typrelid <> 0 AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_class r WHERE r.oid = t.typrelid AND r.relkind <> 'c'))
        AND NOT (t.typelem <> 0 AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_type e WHERE e.oid = t.typelem AND e.typarray = t.oid))`;

/** ユーザー定義の関数・プロシージャ・集約関数・ウィンドウ関数 */
const ROUTINES_SQL = `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE ${NON_SYSTEM_SCHEMA}`;

/**
 * その他のユーザー定義オブジェクト（initdb の後に作られた、OID が FirstNormalObjectId 以上のもの）の件数。
 *
 * OID の条件は、正常な A・C のDBに OID 16384 以上の行が現れないカタログにだけ使う（すべてのカタログには使わない）:
 * - ここに並べたカタログの行は、initdb が作る標準のもの（OID 16384 未満）か、ユーザーが明示的に作ったものだけ。
 *   migration（テーブル・enum・インデックス・制約）も、CREATE DATABASE・初期化スクリプトも、これらに行を作らない。
 * - 例外：外部キーが内部で作るトリガー（tgisinternal）は、C で正常に存在するので数えない。
 * - 正常なDBでも OID 16384 以上の行があるカタログは、OID では数えない:
 *   - pg_class・pg_type・pg_proc・pg_namespace：スキーマで絞り込み、上の一覧で個別に判定する。
 *   - pg_constraint・pg_attrdef・pg_enum・pg_depend など：テーブル・enum に付随する。C の定義の一致は Step 3-12 で照合する。
 *   - pg_database・pg_authid・pg_shdescription など：クラスタ共通（テストDB自身・ロール・DBのコメント）。読まない。
 * - 数えないもの（一般ユーザーが読めないカタログ。作るにはスーパーユーザーの権限が必要）：サブスクリプション・ユーザーマッピング。
 * - 前提（未検証）：initdb が作るオブジェクトの OID は、すべて 16384 未満。外れると、正常なDBが B になる（安全側）。
 */
const OTHER_OBJECT_CATALOGS: readonly (readonly [kind: string, from: string])[] = [
  ["operator", "pg_catalog.pg_operator"],
  ["operator class", "pg_catalog.pg_opclass"],
  ["operator family", "pg_catalog.pg_opfamily"],
  ["collation", "pg_catalog.pg_collation"],
  ["conversion", "pg_catalog.pg_conversion"],
  ["cast", "pg_catalog.pg_cast"],
  ["language", "pg_catalog.pg_language"],
  ["text search configuration", "pg_catalog.pg_ts_config"],
  ["text search dictionary", "pg_catalog.pg_ts_dict"],
  ["text search parser", "pg_catalog.pg_ts_parser"],
  ["text search template", "pg_catalog.pg_ts_template"],
  ["extended statistics", "pg_catalog.pg_statistic_ext"],
  ["rule", "pg_catalog.pg_rewrite"],
  ["trigger", "pg_catalog.pg_trigger"],
  ["policy", "pg_catalog.pg_policy"],
  ["event trigger", "pg_catalog.pg_event_trigger"],
  ["publication", "pg_catalog.pg_publication"],
  ["foreign data wrapper", "pg_catalog.pg_foreign_data_wrapper"],
  ["foreign server", "pg_catalog.pg_foreign_server"],
  ["default privileges", "pg_catalog.pg_default_acl"],
  ["large object", "pg_catalog.pg_largeobject_metadata"],
  ["access method", "pg_catalog.pg_am"],
  ["transform", "pg_catalog.pg_transform"],
];
const OTHER_OBJECTS_SQL = OTHER_OBJECT_CATALOGS.map(
  ([kind, from]) =>
    `SELECT '${kind}' AS kind, pg_catalog.count(*)::int AS count FROM ${from} WHERE oid >= ${FIRST_NORMAL_OBJECT_ID}` +
    (from === "pg_catalog.pg_trigger" ? " AND NOT tgisinternal" : ""),
).join("\n      UNION ALL ");

export type CatalogRelation = { schema: string; name: string; kind: string; ownerSchema: string | null; ownerTable: string | null };
export type CatalogObject = { schema: string; name: string; kind: string };

/** カタログから読んだ、システム以外のオブジェクトの一覧 */
export type CatalogInventory = {
  schemas: string[];
  extensions: string[];
  relations: CatalogRelation[];
  types: CatalogObject[];
  routines: CatalogObject[];
  /** その他のユーザー定義オブジェクトの、種類ごとの件数（0件のものを含む） */
  otherObjects: { kind: string; count: number }[];
};

export type TestDatabaseState =
  | { state: "A" }
  | { state: "B"; reasons: string[] }
  | {
      state: "C";
      tables: string[];
      migrations: string[];
      /** 列・型の中身・インデックス・制約の一致は、まだ確かめていない（Step 3-12 の migrate diff） */
      schemaDiff: "not-verified";
    };

export type TestDatabaseExpectation = {
  /** アプリケーションのテーブル名（applicationTablesFromSchema の結果） */
  tables: readonly string[];
  /** schema.prisma の enum の名前（enumNamesFromSchema の結果） */
  enums: readonly string[];
  /** 適用済みであるべき migration の名前（listMigrationNames の結果。件数を固定しない） */
  migrations: readonly string[];
};

export type ClassifyTestDatabaseInput = {
  /** `.env.test` の検証済みの接続URL */
  databaseUrl: string;
  /** `.env` の開発用DBの接続URL（接続先が同じでないことの確認に使う。なければ undefined） */
  developmentDatabaseUrl: string | undefined;
  expected: TestDatabaseExpectation;
  /** 検証済みの接続URLで、DBに1回だけ接続する */
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
};

/** migration に必要な権限（current_user = katana_test_user から見た値） */
export type TestDatabasePrivileges = {
  /** public スキーマの USAGE */
  publicUsage: boolean;
  /** public スキーマの CREATE（テーブル・型・インデックス・_prisma_migrations を作る） */
  publicCreate: boolean;
  /** current_user が、接続しているDBの所有者（初期化スクリプトの設計。PostgreSQL 15 の public の CREATE は所有者だけにある） */
  databaseOwner: boolean;
  /** 接続しているDBの CREATE（所有者には既定である。今の migration の SQL には不要だが、所有者の設計の確認として必須にする） */
  databaseCreate: boolean;
};

export type TestDatabaseInspection = { state: TestDatabaseState; privileges: TestDatabasePrivileges };

const PRIVILEGE_KEYS = ["publicUsage", "publicCreate", "databaseOwner", "databaseCreate"] as const satisfies readonly (keyof TestDatabasePrivileges)[];

/**
 * 権限を読む（SELECT だけ。search_path を固定し、本人確認に通った後にだけ呼ぶ）。
 * 2引数の has_*_privilege は current_user で評価する。DBの所有者は pg_database.datdba で照合する。
 */
export const PRIVILEGES_SQL = `SELECT pg_catalog.has_schema_privilege('public', 'USAGE') AS "publicUsage",
            pg_catalog.has_schema_privilege('public', 'CREATE') AS "publicCreate",
            pg_catalog.pg_get_userbyid(d.datdba) = current_user AS "databaseOwner",
            pg_catalog.has_database_privilege(d.oid, 'CREATE') AS "databaseCreate"
       FROM pg_catalog.pg_database d
      WHERE d.datname = pg_catalog.current_database()`;

export async function readTestDatabasePrivileges(client: IntegrationDbClient): Promise<TestDatabasePrivileges> {
  const rows = await select(client, "privilege query", PRIVILEGES_SQL);
  const [row] = rows;
  // 1行で、4つとも真偽値であること（読めない値を「権限あり」とは扱わない）
  if (rows.length !== 1 || !PRIVILEGE_KEYS.every((key) => typeof row[key] === "boolean")) {
    throw new IntegrationDatabaseCheckError("PRIVILEGES_UNAVAILABLE", "the migration privileges could not be read.");
  }
  return {
    publicUsage: row.publicUsage as boolean,
    publicCreate: row.publicCreate as boolean,
    databaseOwner: row.databaseOwner as boolean,
    databaseCreate: row.databaseCreate as boolean,
  };
}

/** 足りない権限の名前（すべてあれば空） */
export function missingMigrationPrivileges(privileges: TestDatabasePrivileges): string[] {
  return PRIVILEGE_KEYS.filter((key) => privileges[key] !== true);
}

/** 検査のトランザクションの中だけ、search_path を pg_catalog に固定する（ROLLBACK で元に戻る） */
export const PIN_SEARCH_PATH_SQL = `SELECT pg_catalog.set_config('search_path', 'pg_catalog', true) AS "searchPath"`;

async function pinSearchPath(client: IntegrationDbClient): Promise<void> {
  const [row] = await select(client, "search_path pin", PIN_SEARCH_PATH_SQL);
  if (row?.searchPath !== "pg_catalog") {
    throw new IntegrationDatabaseCheckError("SEARCH_PATH_NOT_PINNED", "search_path could not be pinned to pg_catalog.");
  }
}

/** schema.prisma の enum の名前。`@map`・`@@map` は拒否する（DBの型名との対応を正しく扱えない） */
export function enumNamesFromSchema(schemaSource: string): string[] {
  assertSupportedSchema(schemaSource);
  return [...schemaSource.matchAll(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map((match) => match[1]).sort();
}

const text = (value: unknown) => String(value);
const nullableText = (value: unknown) => (value === null || value === undefined ? null : String(value));

/** カタログの一覧を読む（SELECT だけ） */
export async function readCatalogInventory(client: IntegrationDbClient): Promise<CatalogInventory> {
  const schemas = await select(client, "schema listing", SCHEMAS_SQL);
  const extensions = await select(client, "extension listing", EXTENSIONS_SQL);
  const relations = await select(client, "relation listing", RELATIONS_SQL);
  const types = await select(client, "type listing", TYPES_SQL);
  const routines = await select(client, "routine listing", ROUTINES_SQL);
  const otherObjects = await select(client, "other object listing", OTHER_OBJECTS_SQL);
  const object = (row: Record<string, unknown>): CatalogObject => ({ schema: text(row.schema), name: text(row.name), kind: text(row.kind) });
  return {
    schemas: schemas.map((row) => text(row.name)),
    extensions: extensions.map((row) => text(row.name)),
    relations: relations.map((row) => ({ ...object(row), ownerSchema: nullableText(row.ownerSchema), ownerTable: nullableText(row.ownerTable) })),
    types: types.map(object),
    routines: routines.map(object),
    otherObjects: otherObjects.map((row) => {
      const count = Number(row.count);
      // 件数として読めない値は、オブジェクトがあるものとして扱う（安全側）
      return { kind: text(row.kind), count: Number.isInteger(count) && count >= 0 ? count : Number.POSITIVE_INFINITY };
    }),
  };
}

const describeObject = (o: CatalogObject) => `${o.schema}.${o.name} (${o.kind})`;

function listed(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort();
  const shown = sorted.slice(0, MAX_LISTED).join(", ");
  return [`${label}: ${shown}${sorted.length > MAX_LISTED ? ` (and ${sorted.length - MAX_LISTED} more)` : ""}`];
}

/** A・C のどちらでも許されないもの（想定外のスキーマ・拡張・関数・その他のオブジェクト） */
function commonProblems(inventory: CatalogInventory): string[] {
  return [
    ...(inventory.schemas.includes(APP_SCHEMA) ? [] : [`schema ${APP_SCHEMA} is missing`]),
    ...listed(
      "unexpected schemas",
      inventory.schemas.filter((name) => name !== APP_SCHEMA),
    ),
    ...listed(
      "unexpected extensions",
      inventory.extensions.filter((name) => !ALLOWED_EXTENSIONS.has(name)),
    ),
    ...listed("unexpected routines", inventory.routines.map(describeObject)),
    ...listed(
      "unexpected objects",
      inventory.otherObjects.filter((o) => o.count !== 0).map((o) => `${o.kind} (${Number.isFinite(o.count) ? o.count : "unknown count"})`),
    ),
  ];
}

const isMigrationsTable = (r: CatalogRelation) => r.schema === APP_SCHEMA && r.name === MIGRATIONS_TABLE && r.kind === "r";

/** C の構造の条件（テーブル・インデックス・シーケンス・型）のうち、満たしていないもの */
function migratedStructureProblems(inventory: CatalogInventory, expected: TestDatabaseExpectation): string[] {
  const allowedTables = new Set([...expected.tables, MIGRATIONS_TABLE]);
  const foundTables = new Set<string>();
  const unexpectedRelations: string[] = [];
  for (const r of inventory.relations) {
    const ownedByAllowedTable = r.ownerSchema === APP_SCHEMA && r.ownerTable !== null && allowedTables.has(r.ownerTable);
    if (r.schema === APP_SCHEMA && r.kind === "r" && allowedTables.has(r.name)) foundTables.add(r.name);
    // インデックス・シーケンスは、想定テーブルのものだけを許す（定義の一致は Step 3-12 で照合する）
    else if (r.schema === APP_SCHEMA && (r.kind === "i" || r.kind === "S") && ownedByAllowedTable) continue;
    else unexpectedRelations.push(describeObject(r));
  }
  const expectedEnums = new Set(expected.enums);
  const foundEnums = new Set<string>();
  const unexpectedTypes: string[] = [];
  for (const t of inventory.types) {
    if (t.schema === APP_SCHEMA && t.kind === "e" && expectedEnums.has(t.name)) foundEnums.add(t.name);
    else unexpectedTypes.push(describeObject(t));
  }
  return [
    ...listed(
      "missing tables",
      [...allowedTables].filter((name) => !foundTables.has(name)),
    ),
    ...listed("unexpected relations", unexpectedRelations),
    ...listed(
      "missing enums",
      [...expectedEnums].filter((name) => !foundEnums.has(name)),
    ),
    ...listed("unexpected types", unexpectedTypes),
  ];
}

/**
 * カタログの一覧から、A か、C の候補か、B かを決める（DBには触れない純粋関数）。
 * C の候補は、呼び出し側が migration の履歴と空DB検査で確かめてから C とする。
 */
export function classifyCatalogInventory(
  inventory: CatalogInventory,
  expected: TestDatabaseExpectation,
): { state: "A" } | { state: "B"; reasons: string[] } | { state: "C-candidate" } {
  const common = commonProblems(inventory);
  if (common.length === 0 && inventory.relations.length === 0 && inventory.types.length === 0) return { state: "A" };

  if (!inventory.relations.some(isMigrationsTable)) {
    return {
      state: "B",
      reasons: [
        `the database is not empty and ${MIGRATIONS_TABLE} is missing`,
        ...common,
        ...listed("relations", inventory.relations.map(describeObject)),
        ...listed("types", inventory.types.map(describeObject)),
      ],
    };
  }
  const problems = [...common, ...migratedStructureProblems(inventory, expected)];
  return problems.length === 0 ? { state: "C-candidate" } : { state: "B", reasons: problems };
}

function normalizeExpectation(expected: TestDatabaseExpectation): TestDatabaseExpectation {
  const tables = [...new Set(expected.tables)].sort();
  const enums = [...new Set(expected.enums)].sort();
  const migrations = [...new Set(expected.migrations)].sort();
  if (tables.length === 0) throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "no expected tables were given.");
  if (tables.includes(MIGRATIONS_TABLE)) {
    throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", `${MIGRATIONS_TABLE} must not be an application table.`);
  }
  if (migrations.length === 0) throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "no expected migrations were given.");
  if (migrations.length !== expected.migrations.length) {
    throw new IntegrationDatabaseCheckError("SCHEMA_UNSUPPORTED", "expected migrations contain duplicates.");
  }
  // 空DB検査で SQL に埋め込むので、接続する前に検証する
  tables.forEach(quoteIdentifier);
  enums.forEach(quoteIdentifier);
  return { tables, enums, migrations };
}

/** 1：接続する前に、期待値と接続先を検証する（呼び出し側の検証に加えて、もう一度） */
function prepareCheck(input: ClassifyTestDatabaseInput): TestDatabaseExpectation {
  const expected = normalizeExpectation(input.expected);
  try {
    assertTestDatabaseTarget({ databaseUrl: input.databaseUrl, env: {}, developmentDatabaseUrl: input.developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new IntegrationDatabaseCheckError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    throw error;
  }
  return expected;
}

/**
 * テストDBに接続し、本人確認の後、状態 A・B・C を判定する。DBは変更しない。
 * 本人確認・SQL・接続に失敗したら、状態を返さずに IntegrationDatabaseCheckError を投げる。
 */
export async function classifyTestDatabase(input: ClassifyTestDatabaseInput): Promise<TestDatabaseState> {
  const expected = prepareCheck(input);
  // 2〜7
  return runReadOnlyCheck(input.connect, input.databaseUrl, async (client): Promise<TestDatabaseState> => {
    await pinSearchPath(client); // 3
    await assertDatabaseIdentity(client); // 4：失敗したら throw され、状態の判定に進まない
    return classifyAfterIdentity(client, expected);
  });
}

/**
 * classifyTestDatabase と同じ手順で、本人確認の後に権限も読む（同じ読み取り専用のトランザクション）。
 * 状態の判定は classifyTestDatabase と同じ（権限は判定に影響しない）。権限の SQL が失敗したら、状態を返さずに throw する。
 */
export async function inspectTestDatabase(input: ClassifyTestDatabaseInput): Promise<TestDatabaseInspection> {
  const expected = prepareCheck(input);
  return runReadOnlyCheck(input.connect, input.databaseUrl, async (client): Promise<TestDatabaseInspection> => {
    await pinSearchPath(client);
    await assertDatabaseIdentity(client); // 失敗したら throw され、権限の検査・状態の判定に進まない
    const privileges = await readTestDatabasePrivileges(client);
    const state = await classifyAfterIdentity(client, expected);
    return { state, privileges };
  });
}

/** 5〜6：本人確認の後の、カタログの一覧の取得と状態の判定 */
async function classifyAfterIdentity(client: IntegrationDbClient, expected: TestDatabaseExpectation): Promise<TestDatabaseState> {
  const inventory = await readCatalogInventory(client); // 5
  const structural = classifyCatalogInventory(inventory, expected); // 6
  if (structural.state !== "C-candidate") return structural;

  const history = compareMigrationHistory(await readMigrationHistory(client), expected.migrations);
  if (!history.matches) {
    return {
      state: "B",
      reasons: [
        `migration history does not match (missing: ${history.missing.length}, extra: ${history.extra.length}, ` +
          `failed or rolled back: ${history.notApplied}, duplicated: ${history.duplicated ? "yes" : "no"})`,
        ...listed("missing migrations", history.missing),
        ...listed("unexpected migrations", history.extra),
      ],
    };
  }
  const nonEmpty = await findNonEmptyTables(client, expected.tables);
  if (nonEmpty.length > 0) return { state: "B", reasons: listed("tables are not empty", nonEmpty) };
  return { state: "C", tables: [...expected.tables], migrations: [...expected.migrations], schemaDiff: "not-verified" };
}
