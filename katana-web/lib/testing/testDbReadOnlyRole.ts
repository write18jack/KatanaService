import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import path from "node:path";
import { assertReadOnlyTestDatabaseTarget, assertTestDatabaseTarget, READ_ONLY_TEST_DATABASE_USER, TestDatabaseGuardError } from "../db/testDatabaseGuard.ts";
import {
  assertDatabaseIdentity,
  EXPECTED_DATABASE,
  EXPECTED_USER,
  type IntegrationDbClient,
  IntegrationDatabaseCheckError,
  runReadOnlyCheck,
  select,
  TEST_DATABASE_MARKER,
} from "./integrationDatabaseCheck.ts";
import { inheritAllowedEnv } from "./integrationEnv.ts";
import {
  CATALOG_FINGERPRINT_SECTIONS,
  type CatalogAuditExpectation,
  type CatalogFingerprint,
  classifyReadOnlyRoleSnapshot,
  compareCatalogFingerprints,
  READ_ONLY_ROLE,
  readOnlyRoleExpectation,
  readReadOnlyRoleSnapshot,
  type ReadOnlyRoleSnapshot,
} from "./testDbCatalogAudit.ts";
import { type PinnedServerExpectation, pinnedServerMismatches, type TestDbDockerIdentity } from "./testDbIdentity.ts";
import { pinSearchPath, readServerIdentity } from "./testDbState.ts";

/**
 * schemaDiff 用の読み取り専用ロール katana_test_ro の準備（Step 3-12B-5E-3。docs/PLAN-test-db-isolation.md の 5E-1・5E-2A・5E-2B）。
 *
 * このモジュールは、DB ドライバ・Docker・子プロセスを読み込まない。実行の手順は lib/testing/testDbReadOnlyRoleRunner.ts、
 * 実際の入出力は scripts/testdb-ro-role.mts。ここにあるのは、権限の仕様（固定の値）と、純粋な関数・注入された接続での読み取りだけ。
 *
 * 2つの操作（それぞれ別の固定のゲート。どちらも初期値は無効）:
 * - create（操作1）：ロールが存在しない状態 C のDBに、ロールを作り、16テーブルに SELECT を付与する（docker/test-db/readonly-role/01-create.sql）。
 * - grant-sync（操作2）：将来の migration で増えたテーブルにだけ SELECT を補完する（02-grant-sync.sql）。既存の権限は上書きしない。
 *
 * DB の変更は、固定の SQL ファイルを、固定の引数の docker exec（D1 の Container ID・shell なし・標準入力）で psql に流すことだけで行う。
 * 汎用の SQL の実行・任意の exec の引数は受け付けない。
 *
 * 権限の仕様（明示的に付与・取り上げるものだけ）:
 * - ロール：LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT、所属なし、所有なし、
 *   default_transaction_read_only=on（補助的な防御。書き込みの防止の根拠は権限がないこと）。
 * - katana_test：TEMPORARY を PUBLIC から取り上げる（PUBLIC の CONNECT は残す。ro は CONNECT を PUBLIC から受け取る）。
 * - public schema：変更しない（USAGE は PUBLIC から受け取る。CREATE は PostgreSQL 15 の既定で PUBLIC にない）。
 * - テーブル：期待するテーブル（schema.prisma の15件 + `_prisma_migrations`）に SELECT だけ。sequence・列単位の権限・既定の権限の設定は使わない。
 * - template1 の CONNECT（PUBLIC から）は変更しない（5E-2A で保留。R で「明示的な付与がない」ことを確かめ、残存リスクとして許容する）。
 *   template1 の CREATE・TEMPORARY は、PostgreSQL 15 の initdb が PUBLIC から取り上げている。変更の前に A0 と SQL の事前の照合で確かめ、
 *   違えば変更の前に止まる（Step 3-12B-5E-5A。許容する仕様にはしない・新しい REVOKE もしない）。
 */

/**
 * Docker のコンテキストとコンテナ名（lib/testing/testDbDocker.ts の EXPECTED_DOCKER_CONTEXT・TEST_CONTAINER と同じ値。テストで一致を確かめる）。
 * testDbDocker.ts は子プロセスのモジュールを読み込むので、このモジュールからは参照しない。
 */
export const RO_DOCKER_CONTEXT = "desktop-linux";
export const RO_TEST_CONTAINER = "katana-test-db";

/** katana_test_ro の接続URL・パスワードを置くファイル。`.env.test` には置かない（testdb の検証が未知のキーを拒否するため） */
export const READ_ONLY_ROLE_ENV_FILE = ".env.test.readonly";

export type ReadOnlyRoleOperation = "create" | "grant-sync";

/** 固定の SQL ファイル（init/ の外。初期化では実行されない） */
export const READ_ONLY_ROLE_SQL_FILES: Readonly<Record<ReadOnlyRoleOperation, string>> = Object.freeze({
  create: path.join("docker", "test-db", "readonly-role", "01-create.sql"),
  "grant-sync": path.join("docker", "test-db", "readonly-role", "02-grant-sync.sql"),
});

/** 固定の SQL ファイルの SHA-256。中身が変わったら、レビューの後にこの値も変える（テストで一致を確かめる） */
export const READ_ONLY_ROLE_SQL_SHA256: Readonly<Record<ReadOnlyRoleOperation, string>> = Object.freeze({
  create: "1bcca131a86f81dc4aa0b25650556a929cbf5c643d5437a74d8248a4a5d0585e",
  "grant-sync": "2dcb34b975aaf0f7f84c85a338e2de93f71610d49caf156ed5ce65bcd7f2165e",
});

/** 初回作成で付与するテーブルの件数（schema.prisma の15件 + `_prisma_migrations`）。01-create.sql の中でも同じ値で照合する */
export const EXPECTED_INITIAL_TABLE_COUNT = 16;

// ---- 固定のゲート（それぞれ別の型・別の値。初期値は無効） ----

export type ReadOnlyRoleCreateAccess = { readonly mode: "disabled" } | { readonly mode: "enabled-create" };
export const RO_ROLE_CREATE_DISABLED: ReadOnlyRoleCreateAccess = Object.freeze({ mode: "disabled" });

export type ReadOnlyRoleGrantSyncAccess = { readonly mode: "disabled" } | { readonly mode: "enabled-grant-sync" };
export const RO_ROLE_GRANT_SYNC_DISABLED: ReadOnlyRoleGrantSyncAccess = Object.freeze({ mode: "disabled" });

export type ReadOnlyRoleErrorCode =
  | "ARGUMENTS_INVALID"
  | "EXEC_ARGS_REJECTED"
  | "EXEC_ENV_REJECTED"
  | "TABLE_LIST_INVALID"
  | "SQL_FILE_MISMATCH"
  | "VALUE_INVALID"
  | "TARGET_REJECTED"
  | "IDENTITY_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "CHECK_QUERY_FAILED"
  | "INVALID_RESULT"
  | "FINGERPRINT_UNEXPECTED_CHANGE";

export class ReadOnlyRoleError extends Error {
  readonly code: ReadOnlyRoleErrorCode;

  constructor(code: ReadOnlyRoleErrorCode, detail: string) {
    super(`[readOnlyRole] ${code}: ${detail}`);
    this.name = "ReadOnlyRoleError";
    this.code = code;
  }
}

// ---- 固定の SQL ファイル ----

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 固定の SQL ファイルを読み、SHA-256 が定数と一致することを確かめてから、中身をそのまま返す（置換・連結はしない） */
export function loadReadOnlyRoleSql(root: string, operation: ReadOnlyRoleOperation, readFile: (absolutePath: string) => string): string {
  const sql = readFile(path.join(root, READ_ONLY_ROLE_SQL_FILES[operation]));
  if (sha256Hex(sql) !== READ_ONLY_ROLE_SQL_SHA256[operation]) {
    throw new ReadOnlyRoleError("SQL_FILE_MISMATCH", `${READ_ONLY_ROLE_SQL_FILES[operation]} does not match the reviewed SHA-256; nothing was executed.`);
  }
  return sql;
}

// ---- テーブルの一覧（katana.expected_tables・katana.grant_targets で共通の形） ----

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * テーブル名の一覧を、SQL に渡す1つの文字列にする（expected_tables・grant_targets で共通）。
 * 名前は識別子の形（`,` を含まない）・重複なし。コードポイントの順（SQL 側の `ORDER BY relname COLLATE "C"` と同じ順。名前は ASCII だけ）に並べ、`,` でつなぐ。
 * 空の一覧は拒否する（呼び出し側は、補完の対象が0件のときは exec をしない）。
 */
export function encodeTableList(names: readonly string[]): string {
  if (names.length === 0) throw new ReadOnlyRoleError("TABLE_LIST_INVALID", "the table list is empty.");
  if (names.some((name) => !IDENTIFIER.test(name))) throw new ReadOnlyRoleError("TABLE_LIST_INVALID", "a table name contains unsupported characters.");
  if (new Set(names).size !== names.length) throw new ReadOnlyRoleError("TABLE_LIST_INVALID", "the table list has duplicates.");
  return [...names].sort(compareCodePoints).join(",");
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** katana_test_ro が SELECT を持つべきテーブル（schema.prisma のテーブル + `_prisma_migrations`。コードポイントの順） */
export function expectedReadOnlyRoleTables(expectation: CatalogAuditExpectation): string[] {
  return [...readOnlyRoleExpectation(expectation).tables].sort(compareCodePoints);
}

// ---- SCRAM-SHA-256 の検証子（平文のパスワードをコンテナに送らない） ----

export const SCRAM_ITERATIONS = 4096;
const BASE64 = "[A-Za-z0-9+/]+={0,2}";
/** PostgreSQL が保存する形式：SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey> */
export const SCRAM_VERIFIER_PATTERN = new RegExp(`^SCRAM-SHA-256\\$${SCRAM_ITERATIONS}:${BASE64}\\$${BASE64}:${BASE64}$`);

/**
 * RFC 5802・7677 の鍵の導出。パスワードは `[A-Za-z0-9_-]` だけなので、SASLprep で変化しない（呼び出し側が検証済み）。
 */
export function deriveScramKeys(password: string, salt: Buffer, iterations: number): { clientKey: Buffer; storedKey: Buffer; serverKey: Buffer } {
  const saltedPassword = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return { clientKey, storedKey, serverKey };
}

/** PostgreSQL の pg_authid.rolpassword と同じ形式の検証子を作る（salt は16バイトの乱数） */
export function createScramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new ReadOnlyRoleError("VALUE_INVALID", "the password has unsupported characters.");
  if (salt.length < 16) throw new ReadOnlyRoleError("VALUE_INVALID", "the salt is too short.");
  const { storedKey, serverKey } = deriveScramKeys(password, salt, SCRAM_ITERATIONS);
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// ---- 固定の docker exec ----

/** F1 の pg_postmaster_start_time()（SERVER_IDENTITY_SQL と同じ式の文字列。マイクロ秒6桁・UTC）。Date には変換しない */
export const POSTMASTER_START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** docker exec の `-e 名前`（値は書かない。docker CLI の環境変数から取られる）で渡す変数 */
export const EXEC_ENV = Object.freeze({
  verifier: "KATANA_TEST_RO_SCRAM_VERIFIER",
  verifierSha256: "KATANA_TEST_RO_VERIFIER_SHA256",
  postmasterStart: "KATANA_TEST_EXPECTED_POSTMASTER_START",
  expectedTables: "KATANA_TEST_EXPECTED_TABLES",
  grantTargets: "KATANA_TEST_GRANT_TARGETS",
});

/** 操作ごとに渡す変数（SQL ファイルの \getenv と同じもの。grant-sync は検証子を受け取らない） */
export const EXEC_ENV_KEYS: Readonly<Record<ReadOnlyRoleOperation, readonly string[]>> = Object.freeze({
  create: Object.freeze([EXEC_ENV.verifier, EXEC_ENV.verifierSha256, EXEC_ENV.postmasterStart, EXEC_ENV.expectedTables, EXEC_ENV.grantTargets]),
  "grant-sync": Object.freeze([EXEC_ENV.postmasterStart, EXEC_ENV.expectedTables, EXEC_ENV.grantTargets]),
});

/**
 * コンテナの中の psql の固定の引数。
 * - `--single-transaction` は `-f` と一緒のときだけ確実に効くので、標準入力は `-f -` で読ませる。
 * - ON_ERROR_STOP=1：文が失敗したら COMMIT の代わりに ROLLBACK を送り、終了コード3で終わる（0 にならない）。
 * - `-X`：.psqlrc を読まない（ON_ERROR_ROLLBACK・AUTOCOMMIT などを変えさせない）。`-q`：完了のメッセージを表示しない。
 * - VERBOSITY=terse・SHOW_CONTEXT=never：エラー時に文の抜粋を表示しない。ECHO は設定しない。
 * - `-h` は付けない（コンテナの中の UNIX ソケット。SQL の中で inet_server_addr() が NULL であることを確かめる）。
 */
export const PSQL_ARGS = Object.freeze([
  "psql",
  "-X",
  "-q",
  "-v",
  "ON_ERROR_STOP=1",
  "-v",
  "VERBOSITY=terse",
  "-v",
  "SHOW_CONTEXT=never",
  "--single-transaction",
  "-U",
  "postgres",
  "-d",
  EXPECTED_DATABASE,
  "-f",
  "-",
]);

/** docker exec の引数（固定。変わるのは Container ID だけ）。context は明示する */
export function buildReadOnlyRoleExecArgs(operation: ReadOnlyRoleOperation, containerId: string): readonly string[] {
  if (!CONTAINER_ID.test(containerId)) throw new ReadOnlyRoleError("EXEC_ARGS_REJECTED", "the container id is not a full 64-character id.");
  return Object.freeze([
    "--context",
    RO_DOCKER_CONTEXT,
    "exec",
    "-i",
    "--user",
    "postgres",
    ...EXEC_ENV_KEYS[operation].flatMap((key) => ["-e", key]),
    containerId,
    ...PSQL_ARGS,
  ]);
}

/** docker exec に含まれていてはいけない引数（固定の配列との完全一致に対する、念のための再確認） */
// `-d` は psql の固定の引数（-d katana_test）にあるので、docker の detach は長い形だけを拒否する（照合の主体は完全一致の配列）
const FORBIDDEN_EXEC_ARGS = ["-t", "--tty", "--privileged", "-w", "--workdir", "--env-file", "--detach", "-c", "--command", "-h", "--host"];

/**
 * 実行する直前の引数が、固定の引数と完全に一致し、Container ID が D1・D2 の値と同じことを確かめる。違えば起動しない。
 */
export function assertReadOnlyRoleExecArgs(
  candidate: readonly string[],
  operation: ReadOnlyRoleOperation,
  docker1: TestDbDockerIdentity,
  docker2: TestDbDockerIdentity,
): void {
  if (docker1.containerId !== docker2.containerId || !CONTAINER_ID.test(docker1.containerId)) {
    throw new ReadOnlyRoleError("EXEC_ARGS_REJECTED", "the container id from D1 and D2 is not the same full id; docker exec was not started.");
  }
  const expected = buildReadOnlyRoleExecArgs(operation, docker1.containerId);
  if (candidate.length !== expected.length || candidate.some((arg, i) => arg !== expected[i])) {
    throw new ReadOnlyRoleError("EXEC_ARGS_REJECTED", "the docker exec arguments are not the fixed ones; docker exec was not started.");
  }
  // 念のための再確認：禁止した引数がない。`=` を含むのは psql の固定の値（ON_ERROR_STOP=1 など）だけで、`-e NAME=value`（値を引数に書く形）はない
  const allowedWithEquals = new Set(PSQL_ARGS.filter((arg) => arg.includes("=")));
  if (candidate.some((arg) => FORBIDDEN_EXEC_ARGS.includes(arg) || (arg.includes("=") && !allowedWithEquals.has(arg)))) {
    throw new ReadOnlyRoleError("EXEC_ARGS_REJECTED", "the docker exec arguments contain a forbidden argument; docker exec was not started.");
  }
  if (!candidate.includes(docker1.containerId) || candidate.includes(RO_TEST_CONTAINER)) {
    throw new ReadOnlyRoleError("EXEC_ARGS_REJECTED", "docker exec must target the container id from D1, not the container name.");
  }
}

export type ReadOnlyRoleExecValues = {
  /** F1 の postmasterStartTime（文字列のまま） */
  postmasterStart: string;
  /** encodeTableList の結果 */
  expectedTables: string;
  /** encodeTableList の結果（create では expectedTables と同じ） */
  grantTargets: string;
  /** create だけ：SCRAM の検証子とその SHA-256 */
  verifier?: string;
  verifierSha256?: string;
};

/** docker CLI に渡してはいけない変数（親から引き継がない。組み立てた後にも確かめる） */
const FORBIDDEN_EXEC_ENV = /^(DATABASE_URL$|PG|DOTENV_|COMPOSE_|POSTGRES_|DOCKER_|NODE_OPTIONS$|KATANA_TEST_DB_|KATANA_TEST_RO_DATABASE_URL$|KATANA_DB_)/;

/**
 * docker exec（docker CLI）の環境変数を作る。親からは許可リスト（PATH・HOME など）だけを引き継ぎ、
 * 操作ごとに決まった変数だけを足す。パスワード・接続URL・DOCKER_HOST などは含めない。
 */
export function buildReadOnlyRoleExecEnv(parentEnv: Readonly<Record<string, string | undefined>>, operation: ReadOnlyRoleOperation, values: ReadOnlyRoleExecValues): Record<string, string> {
  if (!POSTMASTER_START_PATTERN.test(values.postmasterStart)) {
    throw new ReadOnlyRoleError("VALUE_INVALID", "the postmaster start time is not the fixed microsecond UTC format.");
  }
  for (const list of [values.expectedTables, values.grantTargets]) {
    if (list === "" || list.split(",").some((name) => !IDENTIFIER.test(name)) || encodeTableList(list.split(",")) !== list) {
      throw new ReadOnlyRoleError("VALUE_INVALID", "a table list is not in the encoded form.");
    }
  }
  const expectedSet = new Set(values.expectedTables.split(","));
  if (values.grantTargets.split(",").some((name) => !expectedSet.has(name))) {
    throw new ReadOnlyRoleError("VALUE_INVALID", "the grant targets are not a subset of the expected tables.");
  }
  const added: Record<string, string> = {
    [EXEC_ENV.postmasterStart]: values.postmasterStart,
    [EXEC_ENV.expectedTables]: values.expectedTables,
    [EXEC_ENV.grantTargets]: values.grantTargets,
  };
  if (operation === "create") {
    if (values.grantTargets !== values.expectedTables || values.expectedTables.split(",").length !== EXPECTED_INITIAL_TABLE_COUNT) {
      throw new ReadOnlyRoleError("VALUE_INVALID", `the initial creation must grant exactly the ${EXPECTED_INITIAL_TABLE_COUNT} expected tables.`);
    }
    if (values.verifier === undefined || !SCRAM_VERIFIER_PATTERN.test(values.verifier)) {
      throw new ReadOnlyRoleError("VALUE_INVALID", "the password verifier is not in the SCRAM-SHA-256 format.");
    }
    if (values.verifierSha256 === undefined || !SHA256_HEX.test(values.verifierSha256) || values.verifierSha256 !== sha256Hex(values.verifier)) {
      throw new ReadOnlyRoleError("VALUE_INVALID", "the verifier hash does not match the verifier.");
    }
    added[EXEC_ENV.verifier] = values.verifier;
    added[EXEC_ENV.verifierSha256] = values.verifierSha256;
  } else if (values.verifier !== undefined || values.verifierSha256 !== undefined) {
    throw new ReadOnlyRoleError("VALUE_INVALID", "grant-sync does not take a password verifier.");
  }
  const { inherited } = inheritAllowedEnv(parentEnv);
  const env = { ...inherited, ...added };
  const forbidden = Object.keys(env).filter((key) => FORBIDDEN_EXEC_ENV.test(key));
  const katanaKeys = Object.keys(env).filter((key) => key.startsWith("KATANA_")).sort();
  if (forbidden.length > 0 || katanaKeys.join(",") !== [...EXEC_ENV_KEYS[operation]].sort().join(",")) {
    throw new ReadOnlyRoleError("EXEC_ENV_REJECTED", "the docker exec environment is not the fixed one.");
  }
  return env;
}

// ---- 読み取り専用ロールの検査（R-base・R-full）。katana_test_ro で接続し、BEGIN READ ONLY の中で SELECT だけ ----

/** katana_test_ro への依存（pg_shdepend）。クラスタ全体。名前に変換し、OID は返さない */
export const RO_DEPENDENCIES_SQL = `SELECT CASE WHEN s.dbid = 0 THEN '' ELSE d.datname::text END AS database,
            CASE WHEN s.classid = 'pg_catalog.pg_class'::pg_catalog.regclass THEN 'pg_class' ELSE 'other' END AS catalog,
            s.objsubid AS "subId", s.deptype::text AS type,
            CASE WHEN s.dbid = (SELECT x.oid FROM pg_catalog.pg_database x WHERE x.datname = pg_catalog.current_database())
                  AND s.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                 THEN (SELECT c.relname::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.oid = s.objid AND n.nspname = 'public') END AS "objectName"
       FROM pg_catalog.pg_shdepend s
       LEFT JOIN pg_catalog.pg_database d ON d.oid = s.dbid
      WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND s.refobjid = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)`;

/** クラスタのすべてのDBに対する current_user の権限と、明示的な付与の件数（ACL が未設定なら既定の ACL で数える） */
export const RO_DATABASES_SQL = `SELECT d.datname::text AS name, d.datallowconn AS "allowConnections",
            pg_catalog.has_database_privilege(d.oid, 'CONNECT') AS connect,
            pg_catalog.has_database_privilege(d.oid, 'TEMPORARY') AS temporary,
            pg_catalog.has_database_privilege(d.oid, 'CREATE') AS "create",
            (SELECT pg_catalog.count(*)::int FROM pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
              WHERE a.grantee = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) AS "explicitGrants"
       FROM pg_catalog.pg_database d`;

/** public のテーブルの ACL が未設定か（R-base で、補完の対象を「ACL が未設定のテーブル」に限るため） */
export const RO_TABLE_ACL_SQL = `SELECT c.relname::text AS "table", c.relacl IS NULL AS "aclNull"
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;

export type ReadOnlyRoleDependency = { database: string; catalog: string; subId: number; type: string; objectName: string | null };
export type ReadOnlyRoleDatabase = { name: string; allowConnections: boolean; connect: boolean; temporary: boolean; create: boolean; explicitGrants: number };
export type ReadOnlyRoleObservation = {
  snapshot: ReadOnlyRoleSnapshot;
  dependencies: ReadOnlyRoleDependency[];
  databases: ReadOnlyRoleDatabase[];
  tableAcl: { table: string; aclNull: boolean }[];
};

function invalid(step: string): ReadOnlyRoleError {
  return new ReadOnlyRoleError("INVALID_RESULT", `the ${step} result is not in the expected form.`);
}

const isText = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isInt = (v: unknown): v is number => Number.isInteger(v);

export async function readReadOnlyRoleObservation(client: IntegrationDbClient): Promise<ReadOnlyRoleObservation> {
  const snapshot = await readReadOnlyRoleSnapshot(client);
  const dependencies = (await select(client, "role dependencies", RO_DEPENDENCIES_SQL)).map((row) => {
    if (!isText(row.database) || !isText(row.catalog) || !isInt(row.subId) || !isText(row.type) || !(row.objectName === null || isText(row.objectName))) {
      throw invalid("role dependencies");
    }
    return { database: row.database, catalog: row.catalog, subId: row.subId, type: row.type, objectName: row.objectName };
  });
  const databases = (await select(client, "role databases", RO_DATABASES_SQL)).map((row) => {
    if (!isText(row.name) || !isBool(row.allowConnections) || !isBool(row.connect) || !isBool(row.temporary) || !isBool(row.create) || !isInt(row.explicitGrants)) {
      throw invalid("role databases");
    }
    return { name: row.name, allowConnections: row.allowConnections, connect: row.connect, temporary: row.temporary, create: row.create, explicitGrants: row.explicitGrants };
  });
  const tableAcl = (await select(client, "table privileges state", RO_TABLE_ACL_SQL)).map((row) => {
    if (!isText(row.table) || !isBool(row.aclNull)) throw invalid("table privileges state");
    return { table: row.table, aclNull: row.aclNull };
  });
  return { snapshot, dependencies, databases, tableAcl };
}

export type ReadOnlyRoleCheckInput = {
  /** `.env.test.readonly` の検証済みの接続URL（katana_test_ro） */
  databaseUrl: string;
  developmentDatabaseUrl: string | undefined;
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
  /** D1・F1 の識別情報。この接続のサーバーが合わなければ、権限を読まずに止まる */
  expectedServer: PinnedServerExpectation;
};

const IDENTITY_CODES = new Set(["NOT_READ_ONLY", "DATABASE_MISMATCH", "CURRENT_USER_MISMATCH", "SESSION_USER_MISMATCH", "MARKER_MISMATCH", "IDENTITY_UNAVAILABLE"]);

/**
 * katana_test_ro で1回だけ接続し、BEGIN READ ONLY → search_path の固定 → 本人確認（katana_test_ro）→ サーバーの識別（D1・F1 と同じ）
 * → 権限・依存・DB の権限・テーブルの ACL の状態を読む → ROLLBACK・接続の解放（runReadOnlyCheck）。DB は変更しない。
 * 判定は呼び出し側（classifyReadOnlyRoleBase・classifyReadOnlyRoleFull）で行う。
 */
export async function runReadOnlyRoleCheck(input: ReadOnlyRoleCheckInput): Promise<ReadOnlyRoleObservation> {
  try {
    assertReadOnlyTestDatabaseTarget({ databaseUrl: input.databaseUrl, env: {}, developmentDatabaseUrl: input.developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new ReadOnlyRoleError("TARGET_REJECTED", `the read-only role target was rejected (${error.code}).`);
    throw error;
  }
  try {
    return await runReadOnlyCheck(input.connect, input.databaseUrl, async (client) => {
      await pinSearchPath(client);
      try {
        await assertDatabaseIdentity(client, READ_ONLY_TEST_DATABASE_USER);
      } catch (error) {
        if (error instanceof IntegrationDatabaseCheckError && IDENTITY_CODES.has(error.code)) {
          throw new ReadOnlyRoleError("IDENTITY_CHECK_FAILED", `the read-only role identity check failed (${error.code}).`);
        }
        throw error;
      }
      const server = await readServerIdentity(client);
      const mismatches = pinnedServerMismatches(server, input.expectedServer);
      if (mismatches.length > 0) {
        throw new ReadOnlyRoleError("SERVER_IDENTITY_MISMATCH", `this connection does not reach the verified server (${mismatches.join(", ")}); the privileges were not read.`);
      }
      return readReadOnlyRoleObservation(client);
    });
  } catch (error) {
    if (error instanceof ReadOnlyRoleError) throw error;
    const code = error instanceof IntegrationDatabaseCheckError ? error.code : (error as { code?: unknown } | null)?.code;
    throw new ReadOnlyRoleError("CHECK_QUERY_FAILED", `the read-only role check failed (${typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown"}).`);
  }
}

/** クラスタに存在してよいDB（それ以外があれば停止） */
const EXPECTED_DATABASES = [EXPECTED_DATABASE, "postgres", "template0", "template1"].sort();

/** DB の権限と依存の検査（R-base・R-full で共通）。grantedTables は「SELECT を持つべきテーブル」 */
function dependencyAndDatabaseViolations(observation: ReadOnlyRoleObservation, grantedTables: readonly string[]): string[] {
  const violations: string[] = [];
  // 依存：所有（o）・ポリシー（r）・その他は0件。ACL（a）は katana_test の pg_class・列ではない・付与したテーブルだけ
  const aclTables: string[] = [];
  for (const dep of observation.dependencies) {
    if (dep.type === "a" && dep.database === EXPECTED_DATABASE && dep.catalog === "pg_class" && dep.subId === 0 && dep.objectName !== null) {
      aclTables.push(dep.objectName);
    } else {
      violations.push(`dependency ${dep.type} in ${dep.database || "(shared)"} (${dep.catalog}${dep.subId !== 0 ? ", column" : ""})`);
    }
  }
  const expectedAcl = [...grantedTables].sort(compareCodePoints).join(",");
  if ([...aclTables].sort(compareCodePoints).join(",") !== expectedAcl) violations.push("privilege dependencies do not match the granted tables");

  const names = observation.databases.map((d) => d.name).sort();
  if (names.join(",") !== EXPECTED_DATABASES.join(",")) violations.push("unexpected databases in the cluster");
  for (const d of observation.databases) {
    if (d.explicitGrants !== 0) violations.push(`database ${d.name}: explicit privileges for the role`);
    if (d.create) violations.push(`database ${d.name}: CREATE`);
    if (d.temporary) violations.push(`database ${d.name}: TEMPORARY`);
    if (d.name === "postgres" && d.connect) violations.push("database postgres: CONNECT");
    if (d.name === "template0" && d.allowConnections) violations.push("database template0 accepts connections");
    if (d.name === EXPECTED_DATABASE && !d.connect) violations.push(`database ${EXPECTED_DATABASE}: no CONNECT`);
    // template1 の CONNECT（PUBLIC から）は、許容する残存リスク（明示的な付与・TEMPORARY・CREATE がないことは上で確かめる）
  }
  return violations;
}

// ---- 変更の前の ACL の照合（A0。Step 3-12B-5E-5A）。katana_test_user で接続し、BEGIN READ ONLY の中で固定の SELECT だけ ----
//
// fingerprint（FP0）は、カレントDB の行だけを持ち、スキーマの ACL を期待値と照合しない。そこで、変更の前に、クラスタのすべてのDBと
// 非システムのスキーマについて、所有者・接続の可否・ACL（未設定なら acldefault で展開）・PUBLIC の実効権限を読み、固定の期待値と比べる。
// 同じ条件を、固定の SQL（01-create.sql・02-grant-sync.sql）でも、最初の変更の文より前に確かめる（二重の検査）。
//
// 期待値の根拠（PostgreSQL 15）:
// - initdb（src/bin/initdb/initdb.c の make_template0）が `REVOKE CREATE,TEMPORARY ON DATABASE template1 FROM public;` と、
//   template0 にも同じ文を実行する → どちらも {=c/postgres,postgres=CTc/postgres}。template0 は ALLOW_CONNECTIONS = false。
// - postgres DB は、初期化スクリプト（docker/test-db/init/01-app-role.sh）の `REVOKE ALL ON DATABASE postgres FROM PUBLIC;` → {postgres=CTc/postgres}。
// - katana_test は所有者が katana_test_user（01-app-role.sh の ALTER DATABASE … OWNER TO）。ACL は create の前は未設定（NULL）、
//   create の後は PUBLIC の TEMPORARY を取り上げた形。
// - public スキーマは、PostgreSQL 15 の既定（所有者 pg_database_owner、{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}）。

/** ACL の項目を「付与先:権限:付与者」（付与先が PUBLIC なら `PUBLIC`。付与の権限があれば `:GRANTABLE` を付ける）にして、コードポイント順に `,` でつなぐ式 */
const canonicalAclSql = (aclExpression: string) =>
  `COALESCE((SELECT pg_catalog.string_agg(i, ',' ORDER BY i COLLATE "C")
                FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                             || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text
                             || CASE WHEN a.is_grantable THEN ':GRANTABLE' ELSE '' END AS i
                        FROM pg_catalog.aclexplode(${aclExpression}) a) items), '')`;

/** クラスタのすべてのDB（所有者・接続の可否・ACL が未設定か・展開した ACL・PUBLIC の実効権限） */
export const PRE_CHANGE_DATABASES_SQL = `SELECT d.datname::text AS name, pg_catalog.pg_get_userbyid(d.datdba)::text AS owner,
            d.datallowconn AS "allowConnections", d.datacl IS NULL AS "aclNull",
            ${canonicalAclSql("COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))")} AS acl,
            pg_catalog.has_database_privilege('public', d.oid, 'CONNECT') AS "publicConnect",
            pg_catalog.has_database_privilege('public', d.oid, 'TEMPORARY') AS "publicTemporary",
            pg_catalog.has_database_privilege('public', d.oid, 'CREATE') AS "publicCreate"
       FROM pg_catalog.pg_database d`;

/** カレントDB の非システムのスキーマ（所有者・ACL が未設定か・展開した ACL・PUBLIC の実効権限） */
export const PRE_CHANGE_SCHEMAS_SQL = `SELECT n.nspname::text AS name, pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner, n.nspacl IS NULL AS "aclNull",
            ${canonicalAclSql("COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))")} AS acl,
            pg_catalog.has_schema_privilege('public', n.oid, 'USAGE') AS "publicUsage",
            pg_catalog.has_schema_privilege('public', n.oid, 'CREATE') AS "publicCreate"
       FROM pg_catalog.pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;

export type PreChangeDatabase = {
  name: string;
  owner: string;
  allowConnections: boolean;
  aclNull: boolean;
  acl: string;
  publicConnect: boolean;
  publicTemporary: boolean;
  publicCreate: boolean;
};
export type PreChangeSchema = { name: string; owner: string; aclNull: boolean; acl: string; publicUsage: boolean; publicCreate: boolean };
export type PreChangeAclObservation = { databases: PreChangeDatabase[]; schemas: PreChangeSchema[] };

const ownerAll = (grantee: string, owner: string) => ["CONNECT", "CREATE", "TEMPORARY"].map((p) => `${grantee}:${p}:${owner}`);
const aclText = (items: readonly string[]) => [...items].sort(compareCodePoints).join(",");

/** template0・template1・postgres（どちらの操作でも同じ。SQL の照合でも同じ文字列を使う） */
export const EXPECTED_PRE_CHANGE_SYSTEM_DATABASES: readonly PreChangeDatabase[] = Object.freeze([
  { name: "postgres", owner: "postgres", allowConnections: true, aclNull: false, acl: aclText(ownerAll("postgres", "postgres")), publicConnect: false, publicTemporary: false, publicCreate: false },
  {
    name: "template0",
    owner: "postgres",
    allowConnections: false,
    aclNull: false,
    acl: aclText(["PUBLIC:CONNECT:postgres", ...ownerAll("postgres", "postgres")]),
    publicConnect: true,
    publicTemporary: false,
    publicCreate: false,
  },
  {
    name: "template1",
    owner: "postgres",
    allowConnections: true,
    aclNull: false,
    acl: aclText(["PUBLIC:CONNECT:postgres", ...ownerAll("postgres", "postgres")]),
    publicConnect: true,
    publicTemporary: false,
    publicCreate: false,
  },
]);

/** katana_test（create の前は ACL が未設定、grant-sync の前は create の後の形） */
export const EXPECTED_PRE_CHANGE_TEST_DATABASE: Readonly<Record<ReadOnlyRoleOperation, PreChangeDatabase>> = Object.freeze({
  create: {
    name: EXPECTED_DATABASE,
    owner: EXPECTED_USER,
    allowConnections: true,
    aclNull: true,
    acl: aclText([`PUBLIC:CONNECT:${EXPECTED_USER}`, `PUBLIC:TEMPORARY:${EXPECTED_USER}`, ...ownerAll(EXPECTED_USER, EXPECTED_USER)]),
    publicConnect: true,
    publicTemporary: true,
    publicCreate: false,
  },
  "grant-sync": {
    name: EXPECTED_DATABASE,
    owner: EXPECTED_USER,
    allowConnections: true,
    aclNull: false,
    acl: aclText([`PUBLIC:CONNECT:${EXPECTED_USER}`, ...ownerAll(EXPECTED_USER, EXPECTED_USER)]),
    publicConnect: true,
    publicTemporary: false,
    publicCreate: false,
  },
});

/** 非システムのスキーマは public だけ（PostgreSQL 15 の既定） */
export const EXPECTED_PRE_CHANGE_SCHEMAS: readonly PreChangeSchema[] = Object.freeze([
  {
    name: "public",
    owner: "pg_database_owner",
    aclNull: false,
    acl: aclText(["PUBLIC:USAGE:pg_database_owner", "pg_database_owner:CREATE:pg_database_owner", "pg_database_owner:USAGE:pg_database_owner"]),
    publicUsage: true,
    publicCreate: false,
  },
]);

function rowsViolations<T extends { name: string }>(kind: string, actual: readonly T[], expected: readonly T[]): string[] {
  const violations: string[] = [];
  const names = (rows: readonly T[]) => rows.map((r) => r.name).sort(compareCodePoints).join(",");
  if (names(actual) !== names(expected)) violations.push(`the ${kind}s are not the expected ones`);
  for (const e of expected) {
    const a = actual.find((r) => r.name === e.name);
    if (!a) continue;
    for (const field of Object.keys(e) as (keyof T)[]) {
      if (a[field] !== e[field]) violations.push(`${kind} ${e.name}: ${String(field)} differs`);
    }
  }
  return violations;
}

/** A0 の判定：期待値との違いの一覧（空なら一致）。値そのものは返さない（項目名だけ） */
export function preChangeAclViolations(observation: PreChangeAclObservation, operation: ReadOnlyRoleOperation): string[] {
  return [
    ...rowsViolations("database", observation.databases, [...EXPECTED_PRE_CHANGE_SYSTEM_DATABASES, EXPECTED_PRE_CHANGE_TEST_DATABASE[operation]]),
    ...rowsViolations("schema", observation.schemas, EXPECTED_PRE_CHANGE_SCHEMAS),
  ];
}

export async function readPreChangeAclObservation(client: IntegrationDbClient): Promise<PreChangeAclObservation> {
  const databases = (await select(client, "pre-change databases", PRE_CHANGE_DATABASES_SQL)).map((row) => {
    if (
      !isText(row.name) || !isText(row.owner) || !isBool(row.allowConnections) || !isBool(row.aclNull) || !isText(row.acl) ||
      !isBool(row.publicConnect) || !isBool(row.publicTemporary) || !isBool(row.publicCreate)
    ) {
      throw invalid("pre-change databases");
    }
    return {
      name: row.name,
      owner: row.owner,
      allowConnections: row.allowConnections,
      aclNull: row.aclNull,
      acl: row.acl,
      publicConnect: row.publicConnect,
      publicTemporary: row.publicTemporary,
      publicCreate: row.publicCreate,
    };
  });
  const schemas = (await select(client, "pre-change schemas", PRE_CHANGE_SCHEMAS_SQL)).map((row) => {
    if (!isText(row.name) || !isText(row.owner) || !isBool(row.aclNull) || !isText(row.acl) || !isBool(row.publicUsage) || !isBool(row.publicCreate)) {
      throw invalid("pre-change schemas");
    }
    return { name: row.name, owner: row.owner, aclNull: row.aclNull, acl: row.acl, publicUsage: row.publicUsage, publicCreate: row.publicCreate };
  });
  return { databases, schemas };
}

export type PreChangeAclCheckInput = {
  /** `.env.test` の検証済みの接続URL（katana_test_user） */
  databaseUrl: string;
  developmentDatabaseUrl: string | undefined;
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
  /** D1・F1 の識別情報。この接続のサーバーが合わなければ、ACL を読まずに止まる */
  expectedServer: PinnedServerExpectation;
};

/**
 * A0：katana_test_user で1回だけ接続し、BEGIN READ ONLY → search_path の固定 → 本人確認（katana_test_user）→ サーバーの識別（D1・F1 と同じ）
 * → 固定の SELECT 2つ（PRE_CHANGE_DATABASES_SQL・PRE_CHANGE_SCHEMAS_SQL）→ ROLLBACK・接続の解放（runReadOnlyCheck）。DB は変更しない。
 * 判定は呼び出し側（preChangeAclViolations）で行う。
 */
export async function runPreChangeAclCheck(input: PreChangeAclCheckInput): Promise<PreChangeAclObservation> {
  try {
    assertTestDatabaseTarget({ databaseUrl: input.databaseUrl, env: {}, developmentDatabaseUrl: input.developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new ReadOnlyRoleError("TARGET_REJECTED", `the pre-change ACL check target was rejected (${error.code}).`);
    throw error;
  }
  try {
    return await runReadOnlyCheck(input.connect, input.databaseUrl, async (client) => {
      await pinSearchPath(client);
      try {
        await assertDatabaseIdentity(client);
      } catch (error) {
        if (error instanceof IntegrationDatabaseCheckError && IDENTITY_CODES.has(error.code)) {
          throw new ReadOnlyRoleError("IDENTITY_CHECK_FAILED", `the pre-change ACL check identity check failed (${error.code}).`);
        }
        throw error;
      }
      const server = await readServerIdentity(client);
      const mismatches = pinnedServerMismatches(server, input.expectedServer);
      if (mismatches.length > 0) {
        throw new ReadOnlyRoleError("SERVER_IDENTITY_MISMATCH", `this connection does not reach the verified server (${mismatches.join(", ")}); the ACLs were not read.`);
      }
      return readPreChangeAclObservation(client);
    });
  } catch (error) {
    if (error instanceof ReadOnlyRoleError) throw error;
    const code = error instanceof IntegrationDatabaseCheckError ? error.code : (error as { code?: unknown } | null)?.code;
    throw new ReadOnlyRoleError("CHECK_QUERY_FAILED", `the pre-change ACL check failed (${typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown"}).`);
  }
}

export type ReadOnlyRoleVerdict = { readonly passed: boolean; readonly findings: readonly string[] };

/**
 * R-full：期待するテーブルすべてに SELECT があり、列がすべて見え、書き込み・所属・所有・余分な依存・余分な DB の権限がない。
 * 操作1・2の後と、schemaDiff の R1・R2 で使う。
 */
export function classifyReadOnlyRoleFull(observation: ReadOnlyRoleObservation, tables: readonly string[]): ReadOnlyRoleVerdict {
  const report = classifyReadOnlyRoleSnapshot(observation.snapshot, { role: READ_ONLY_ROLE, tables: [...tables] });
  const findings = [...report.findings.map((f) => `${f.category}: ${f.items.join(", ")}`), ...dependencyAndDatabaseViolations(observation, tables)];
  return { passed: report.verdict === "passed" && findings.length === 0, findings };
}

/**
 * R-base（操作2の前だけ）：R-full と同じ基準で検査するが、SELECT のないテーブルのうち、期待するテーブルで、ACL が未設定のものだけを
 * 「補完の対象」として返す（違反にしない）。ACL が設定されているのに SELECT がないテーブル・期待しないテーブルは違反。
 */
export function classifyReadOnlyRoleBase(observation: ReadOnlyRoleObservation, tables: readonly string[]): ReadOnlyRoleVerdict & { readonly candidates: readonly string[] } {
  const expected = new Set(tables);
  const aclNull = new Map(observation.tableAcl.map((t) => [t.table, t.aclNull]));
  const findings: string[] = [];
  const candidates: string[] = [];
  for (const t of observation.snapshot.tables) {
    if (t.select) continue;
    if (!expected.has(t.table)) continue; // classifyReadOnlyRoleSnapshot が UNEXPECTED_OBJECT として扱う
    if (aclNull.get(t.table) !== true) {
      findings.push(`${t.table}: privileges are set but there is no SELECT`);
      continue;
    }
    // 補完の対象は、縮めたスナップショット（下）から外すので、書き込み系の権限がないことをここで確かめる
    const writes = (["insert", "update", "delete", "truncate", "references", "trigger"] as const).filter((p) => t[p]);
    if (writes.length > 0) findings.push(...writes.map((p) => `${t.table} ${p.toUpperCase()}`));
    else candidates.push(t.table);
  }
  if (observation.tableAcl.length !== observation.snapshot.tables.length || observation.tableAcl.some((t) => !observation.snapshot.tables.some((s) => s.table === t.table))) {
    findings.push("the table privilege states do not match the table list");
  }
  const skip = new Set(candidates);
  const reduced: ReadOnlyRoleSnapshot = {
    ...observation.snapshot,
    tables: observation.snapshot.tables.filter((t) => !skip.has(t.table)),
    catalogColumns: observation.snapshot.catalogColumns.filter((c) => !skip.has(c.table)),
    visibleColumns: observation.snapshot.visibleColumns.filter((c) => !skip.has(c.table)),
  };
  const granted = tables.filter((t) => !skip.has(t));
  const full = classifyReadOnlyRoleFull({ ...observation, snapshot: reduced }, granted);
  const all = [...findings, ...full.findings];
  return { passed: all.length === 0, findings: all, candidates: candidates.sort(compareCodePoints) };
}

// ---- fingerprint の期待差分（操作の前 FP0 と後 FP1） ----

/** aclitem の配列の文字列（`{a=r/b,=c/b}`）を、並びに依存しない形にする。引用符を含む名前は扱わない（拒否する） */
export function canonicalAcl(text: string | null): string[] | null {
  if (text === null) return null;
  const match = /^\{(.*)\}$/.exec(text);
  if (!match || text.includes('"')) throw new ReadOnlyRoleError("FINGERPRINT_UNEXPECTED_CHANGE", "an ACL could not be parsed.");
  if (match[1] === "") return [];
  return match[1]
    .split(",")
    .map((item) => {
      const parts = /^([A-Za-z0-9_]*)=([A-Za-z*]+)\/([A-Za-z0-9_]+)$/.exec(item);
      if (!parts) throw new ReadOnlyRoleError("FINGERPRINT_UNEXPECTED_CHANGE", "an ACL item could not be parsed.");
      return `${parts[1]}=${[...parts[2]].sort(compareCodePoints).join("")}/${parts[3]}`;
    })
    .sort(compareCodePoints);
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null) => a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]);

/** 操作1の後の katana_test の ACL（PUBLIC の TEMPORARY を取り上げた形。付与者は所有者） */
export const EXPECTED_DATABASE_ACL_AFTER_CREATE = canonicalAcl(`{=c/${EXPECTED_USER},${EXPECTED_USER}=CTc/${EXPECTED_USER}}`);
/** 付与した後のテーブルの ACL（PostgreSQL 15 の所有者の権限 arwdDxt と、ro の SELECT。付与者は所有者） */
export const EXPECTED_TABLE_ACL_AFTER_GRANT = canonicalAcl(`{${EXPECTED_USER}=arwdDxt/${EXPECTED_USER},${READ_ONLY_ROLE}=r/${EXPECTED_USER}}`);
/** ロールの設定（rolconfig・pg_db_role_setting.setconfig）の配列の文字列。fingerprint は DB の中で md5 にした値を持つ */
export const EXPECTED_ROLE_CONFIG_MD5 = createHash("md5").update("{default_transaction_read_only=on}", "utf8").digest("hex");

const keyOf = (...parts: string[]) => JSON.stringify(parts);
type Row = Record<string, unknown>;

function rowOf(fingerprint: CatalogFingerprint, section: string, key: string): Row | undefined {
  const entry = (fingerprint.sections[section] ?? []).find(([k]) => k === key);
  return entry === undefined ? undefined : (Object.fromEntries(JSON.parse(entry[1]) as [string, unknown][]) as Row);
}

function sameExceptAcl(before: Row, after: Row): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every((k) => k === "acl" || JSON.stringify(before[k]) === JSON.stringify(after[k]));
}

/**
 * FP0 → FP1 の差分が、操作で想定した区分・キー・項目だけであることを確かめる（それ以外の差分・値の違いは失敗）。
 * - create：database（katana_test の acl だけ）、relations（付与した各テーブルの acl だけ）、roles（katana_test_ro の行が1件増える）、
 *   dbRoleSettings（katana_test_ro の行が1件増える）。public schema・列・依存・所属・既定の権限・large object などは変化なし。
 * - grant-sync：relations（補完した各テーブルの acl だけ）。
 * 失敗のメッセージには、区分の名前と件数だけを含める（ハッシュ・値は含めない）。
 */
export function assertReadOnlyRoleFingerprintChange(before: CatalogFingerprint, after: CatalogFingerprint, change: { operation: ReadOnlyRoleOperation; grantedTables: readonly string[] }): void {
  const fail = (detail: string) => new ReadOnlyRoleError("FINGERPRINT_UNEXPECTED_CHANGE", `the catalog changed in an unexpected way: ${detail}.`);
  const { changes } = compareCatalogFingerprints(before, after);
  const relationKeys = change.grantedTables.map((t) => keyOf("public", t)).sort(compareCodePoints);
  const databaseKey = keyOf(EXPECTED_DATABASE);
  const roleKey = keyOf(READ_ONLY_ROLE);
  const settingKey = keyOf("all", "", "one", READ_ONLY_ROLE);
  const expected: Record<string, { added: string[]; removed: string[]; changed: string[] }> =
    change.operation === "create"
      ? {
          database: { added: [], removed: [], changed: [databaseKey] },
          dbRoleSettings: { added: [settingKey], removed: [], changed: [] },
          relations: { added: [], removed: [], changed: relationKeys },
          roles: { added: [roleKey], removed: [], changed: [] },
        }
      : { relations: { added: [], removed: [], changed: relationKeys } };
  if (relationKeys.length === 0) throw fail("no tables were expected to change");

  const actualSections = changes.map((c) => c.section).sort();
  if (actualSections.join(",") !== Object.keys(expected).sort().join(",")) {
    throw fail(`changed sections ${actualSections.join(", ") || "(none)"}`);
  }
  for (const c of changes) {
    const e = expected[c.section];
    for (const kind of ["added", "removed", "changed"] as const) {
      if ([...c[kind]].sort(compareCodePoints).join("\n") !== [...e[kind]].sort(compareCodePoints).join("\n")) {
        throw fail(`${c.section} (${kind} ${c[kind].length}, expected ${e[kind].length})`);
      }
    }
  }
  for (const key of relationKeys) {
    const b = rowOf(before, "relations", key);
    const a = rowOf(after, "relations", key);
    if (!b || !a || !sameExceptAcl(b, a) || b.acl !== null || b.kind !== "r" || !sameList(canonicalAcl(a.acl as string | null), EXPECTED_TABLE_ACL_AFTER_GRANT)) {
      throw fail("relations (a table ACL is not the expected one)");
    }
  }
  if (change.operation === "create") {
    const b = rowOf(before, "database", databaseKey);
    const a = rowOf(after, "database", databaseKey);
    if (!b || !a || !sameExceptAcl(b, a) || b.acl !== null || !sameList(canonicalAcl(a.acl as string | null), EXPECTED_DATABASE_ACL_AFTER_CREATE)) {
      throw fail("database (the ACL is not the expected one)");
    }
    const role = rowOf(after, "roles", roleKey);
    const expectedRole: Row = {
      name: READ_ONLY_ROLE,
      superuser: false,
      inherit: false,
      createRole: false,
      createDb: false,
      login: true,
      replication: false,
      bypassRls: false,
      connectionLimit: -1,
      config: EXPECTED_ROLE_CONFIG_MD5,
    };
    if (!role || JSON.stringify(Object.keys(role).sort()) !== JSON.stringify(Object.keys(expectedRole).sort()) || Object.keys(expectedRole).some((k) => role[k] !== expectedRole[k])) {
      throw fail("roles (the role attributes are not the expected ones)");
    }
    const setting = rowOf(after, "dbRoleSettings", settingKey);
    if (!setting || setting.configHash !== EXPECTED_ROLE_CONFIG_MD5 || setting.databaseScope !== "all" || setting.roleScope !== "one" || setting.role !== READ_ONLY_ROLE) {
      throw fail("dbRoleSettings (the role setting is not the expected one)");
    }
  }
}

/** FP0 の時点で、操作1を始めてよい状態か（ロール・その設定がない、DB の ACL が未設定、期待するテーブルの ACL がすべて未設定） */
export function initialCreationPreconditionViolations(before: CatalogFingerprint, tables: readonly string[]): string[] {
  const violations: string[] = [];
  if (rowOf(before, "roles", keyOf(READ_ONLY_ROLE))) violations.push(`${READ_ONLY_ROLE} already exists`);
  if ((before.sections.dbRoleSettings ?? []).some(([key]) => (JSON.parse(key) as string[])[3] === READ_ONLY_ROLE)) violations.push("role settings for the role exist");
  const database = rowOf(before, "database", keyOf(EXPECTED_DATABASE));
  if (!database || database.acl !== null) violations.push("the database ACL is not the initial one");
  for (const t of tables) {
    const relation = rowOf(before, "relations", keyOf("public", t));
    if (!relation || relation.acl !== null || relation.kind !== "r") violations.push(`table ${t} is missing or already has privileges`);
  }
  if ((before.sections.defaultPrivileges ?? []).length > 0) violations.push("default privilege settings exist");
  return violations;
}

/** FP0 の時点で ACL が未設定の、期待するテーブル（R-base の補完の対象と一致することを確かめる） */
export function tablesWithoutAcl(before: CatalogFingerprint, tables: readonly string[]): string[] {
  return tables.filter((t) => rowOf(before, "relations", keyOf("public", t))?.acl === null).sort(compareCodePoints);
}

// ---- 作成後の独立した検証（--verify-created。Step 3-12B-5E-7A） ----
//
// 作成済みの katana_test_ro について、変更の操作から独立した読み取り専用の経路で、今のカタログが「作成後の期待状態」であることを確かめる。
// 期待値は、DB から独立した情報だけから作る（schema.prisma・migration〔loadCatalogAuditExpectation〕、初期化スクリプト、
// 01-create.sql と同じ定数、PostgreSQL 15 の既定）。**今回読んだ fingerprint を期待値にはしない**（自己比較で成功にしない）。
// 工程6の FP1 は保存していないので、基準にしない。
//
// 18区分の扱い（CREATED_FINGERPRINT_COVERAGE）:
// - exact：区分のすべての行が、組み立てた期待値と一致する（行の追加・欠け・値の違いを検出する）。
// - partial（relations）：テーブル・sequence・その他の種類の行は exact。インデックスの行は不変条件だけ。
// - invariants：決めた不変条件だけを確かめる。名前・件数・定義の完全な一致は確かめない（schemaDiff の範囲）。

/** PostgreSQL 15 の bootstrap のスーパーユーザー（src/include/catalog/pg_authid.dat の oid 10。initdb が名前を postgres にする） */
export const PG15_BOOTSTRAP_SUPERUSER_ROW = Object.freeze({
  name: "postgres",
  superuser: true,
  inherit: true,
  createRole: true,
  createDb: true,
  login: true,
  replication: true,
  bypassRls: true,
  connectionLimit: -1,
  config: null,
});

/** アプリ用のロール（docker/test-db/init/01-app-role.sh の CREATE ROLE。INHERIT と接続の上限は既定値、設定はなし） */
export const EXPECTED_APP_ROLE_ROW = Object.freeze({
  name: EXPECTED_USER,
  superuser: false,
  inherit: true,
  createRole: false,
  createDb: false,
  login: true,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  config: null,
});

/** 作成後の katana_test_ro（01-create.sql の CREATE ROLE・ALTER ROLE。assertReadOnlyRoleFingerprintChange の期待値と同じ） */
export const EXPECTED_CREATED_RO_ROLE_ROW = Object.freeze({
  name: READ_ONLY_ROLE,
  superuser: false,
  inherit: false,
  createRole: false,
  createDb: false,
  login: true,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  config: EXPECTED_ROLE_CONFIG_MD5,
});

/** 作成後の pg_db_role_setting（ALTER ROLE katana_test_ro SET default_transaction_read_only = on の1行だけ） */
export const EXPECTED_CREATED_ROLE_SETTING_ROW = Object.freeze({
  databaseScope: "all",
  database: "",
  roleScope: "one",
  role: READ_ONLY_ROLE,
  configHash: EXPECTED_ROLE_CONFIG_MD5,
});

/**
 * PostgreSQL 15 の既定のロールの所属（src/backend/catalog/system_functions.sql の
 * `GRANT pg_read_all_settings TO pg_monitor;`・`GRANT pg_read_all_stats TO pg_monitor;`・`GRANT pg_stat_scan_tables TO pg_monitor;`。
 * WITH ADMIN OPTION はないので admin_option = false）。pg_auth_members の列は roleid・member・grantor・admin_option で、
 * fingerprint は roleid・member を名前にし、admin_option と一緒に読む（grantor は読まない）。
 */
export const PG15_DEFAULT_ROLE_MEMBERSHIPS = Object.freeze([
  Object.freeze({ role: "pg_read_all_settings", member: "pg_monitor", admin: false }),
  Object.freeze({ role: "pg_read_all_stats", member: "pg_monitor", admin: false }),
  Object.freeze({ role: "pg_stat_scan_tables", member: "pg_monitor", admin: false }),
]);

/** PostgreSQL 15 の既定の拡張（initdb が作る plpgsql だけ。状態 C の判定でも、ほかの拡張は許さない） */
export const PG15_PLPGSQL_EXTENSION_ROW = Object.freeze({ name: "plpgsql", version: "1.0", schema: "pg_catalog" });

/** public スキーマの ACL（PostgreSQL 15 の既定。EXPECTED_PRE_CHANGE_SCHEMAS と同じ内容を aclitem の形で表したもの） */
export const EXPECTED_PUBLIC_SCHEMA_ACL = canonicalAcl("{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}");

/** sequence の件数（migration に SERIAL・IDENTITY・CREATE SEQUENCE がない。静的テストで migration を走査して確かめる） */
export const EXPECTED_SEQUENCE_COUNT = 0;

/** 作成後の katana_test の行（A1）。grant-sync の前の期待値と同じ（ACL は設定済み・PUBLIC は CONNECT だけ） */
export const EXPECTED_CREATED_TEST_DATABASE: PreChangeDatabase = EXPECTED_PRE_CHANGE_TEST_DATABASE["grant-sync"];

export type CreatedFingerprintCoverage = {
  readonly coverage: "exact" | "partial" | "invariants";
  /** 確かめる内容 */
  readonly checked: string;
  /** 確かめない内容（invariants・partial だけ。成功の表示にもそのまま出す） */
  readonly notVerified?: string;
};

/** 18区分の扱い（区分の名前は CATALOG_FINGERPRINT_SECTIONS と同じ。テストで一致を確かめる） */
export const CREATED_FINGERPRINT_COVERAGE: Readonly<Record<string, CreatedFingerprintCoverage>> = Object.freeze({
  columns: {
    coverage: "invariants",
    checked: "every column belongs to an expected public table, every expected table has columns, and no column has its own ACL",
    notVerified: "column names, positions, types, NOT NULL, defaults, identity, generation and collation",
  },
  constraints: {
    coverage: "invariants",
    checked: "every constraint belongs to an expected public table and is a primary key, foreign key or unique constraint",
    notVerified: "constraint names, counts and definitions",
  },
  database: { coverage: "exact", checked: "name, owner, marker comment and the ACL after creation" },
  dbRoleSettings: { coverage: "exact", checked: "only the default_transaction_read_only setting of katana_test_ro" },
  defaultPrivileges: { coverage: "exact", checked: "no rows" },
  enumValues: { coverage: "exact", checked: "values and order replayed from the migrations" },
  extensions: { coverage: "exact", checked: "only plpgsql 1.0 in pg_catalog (PostgreSQL 15)" },
  indexes: {
    coverage: "invariants",
    checked: "every index belongs to an expected public table and is valid",
    notVerified: "index names, counts and definitions",
  },
  largeObjects: { coverage: "exact", checked: "no rows" },
  policies: { coverage: "exact", checked: "no rows" },
  relations: {
    coverage: "partial",
    checked: "exactly the expected tables with the owner, flags and ACL after creation, no sequences, no other relation kinds; index rows: owner, flags, no ACL, and the same names as the indexes section",
    notVerified: "index names and counts",
  },
  roleMemberships: { coverage: "exact", checked: "only the PostgreSQL 15 default memberships of pg_monitor" },
  roles: { coverage: "exact", checked: "exactly postgres, katana_test_user and katana_test_ro with their attributes and settings" },
  routines: { coverage: "exact", checked: "no rows" },
  schemas: { coverage: "exact", checked: "only public with the PostgreSQL 15 owner and ACL" },
  sequences: { coverage: "exact", checked: "no rows" },
  triggers: { coverage: "exact", checked: "no rows" },
  types: { coverage: "exact", checked: "the row and array types of the expected tables and the enum and array types of the expected enums" },
});

type CreatedRow = Record<string, unknown>;

function sectionRows(fingerprint: CatalogFingerprint, section: string): CreatedRow[] {
  return (fingerprint.sections[section] ?? []).map(([, row]) => Object.fromEntries(JSON.parse(row) as [string, unknown][]) as CreatedRow);
}

/** 期待する行を、fingerprint と同じ形の文字列にする（項目の名前の順に並べる。欠けた項目は null） */
function normalizedRow(section: string, row: Readonly<CreatedRow>): string {
  const fields = Object.keys(CATALOG_FINGERPRINT_SECTIONS[section].fields).sort();
  return JSON.stringify(fields.map((f) => [f, row[f] ?? null]));
}

/** exact の区分：行の集合が期待値と完全に一致する。違いは件数だけを返す（値は返さない） */
function exactSectionViolations(fingerprint: CatalogFingerprint, section: string, expected: readonly Readonly<CreatedRow>[]): string[] {
  const actual = new Set((fingerprint.sections[section] ?? []).map(([, row]) => row));
  const wanted = new Set(expected.map((row) => normalizedRow(section, row)));
  const unexpected = [...actual].filter((row) => !wanted.has(row)).length;
  const missing = [...wanted].filter((row) => !actual.has(row)).length;
  return unexpected + missing === 0 ? [] : [`${section}: ${unexpected} unexpected or different, ${missing} missing`];
}

function sameCanonicalAcl(text: unknown, expected: readonly string[] | null): boolean {
  if (text !== null && typeof text !== "string") return false;
  try {
    return sameList(canonicalAcl(text), expected);
  } catch {
    return false;
  }
}

/** fingerprint に katana_test_ro の行があるか（ROLE_NOT_CREATED の判定） */
export function readOnlyRoleExistsIn(fingerprint: CatalogFingerprint): boolean {
  return rowOf(fingerprint, "roles", keyOf(READ_ONLY_ROLE)) !== undefined;
}

/**
 * FP-created：今のカタログの fingerprint が、作成後の期待状態であることを確かめる（純粋関数）。違反の一覧を返す（空なら一致）。
 * 違反の文字列は、区分・種類・件数だけ（ACL・ロールの設定・定義の値は含めない）。
 * invariants の区分（columns・constraints・indexes と relations のインデックスの行）では、名前・件数・定義の完全な一致は確かめない。
 */
export function createdCatalogViolations(fingerprint: CatalogFingerprint, expectation: CatalogAuditExpectation, tables: readonly string[]): string[] {
  const violations: string[] = [];
  const sections = Object.keys(CATALOG_FINGERPRINT_SECTIONS).sort();
  if (Object.keys(fingerprint.sections).sort().join(",") !== sections.join(",")) return ["the fingerprint sections are not the expected ones"];
  const tableSet = new Set(tables);
  if (tableSet.size !== EXPECTED_INITIAL_TABLE_COUNT || tableSet.size !== tables.length) return ["the expected table list is not the initial one"];

  // database（exact）
  const database = sectionRows(fingerprint, "database");
  const db = database[0];
  if (
    database.length !== 1 || db.name !== EXPECTED_DATABASE || db.owner !== EXPECTED_USER || db.comment !== TEST_DATABASE_MARKER ||
    !sameCanonicalAcl(db.acl, EXPECTED_DATABASE_ACL_AFTER_CREATE)
  ) {
    violations.push("database: not the expected row after creation");
  }

  // schemas（exact）
  const schemas = sectionRows(fingerprint, "schemas");
  if (schemas.length !== 1 || schemas[0].name !== "public" || schemas[0].owner !== "pg_database_owner" || !sameCanonicalAcl(schemas[0].acl, EXPECTED_PUBLIC_SCHEMA_ACL)) {
    violations.push("schemas: not only public with the PostgreSQL 15 owner and ACL");
  }

  // extensions・roles・dbRoleSettings・roleMemberships（exact）
  violations.push(...exactSectionViolations(fingerprint, "extensions", [PG15_PLPGSQL_EXTENSION_ROW]));
  violations.push(...exactSectionViolations(fingerprint, "roles", [PG15_BOOTSTRAP_SUPERUSER_ROW, EXPECTED_APP_ROLE_ROW, EXPECTED_CREATED_RO_ROLE_ROW]));
  violations.push(...exactSectionViolations(fingerprint, "dbRoleSettings", [EXPECTED_CREATED_ROLE_SETTING_ROW]));
  violations.push(...exactSectionViolations(fingerprint, "roleMemberships", PG15_DEFAULT_ROLE_MEMBERSHIPS));

  // 0行の区分（exact）
  for (const section of ["defaultPrivileges", "largeObjects", "policies", "routines", "sequences", "triggers"]) {
    violations.push(...exactSectionViolations(fingerprint, section, []));
  }

  // enumValues（exact。migration から再現した値と順序）
  if (expectation.enums.status !== "supported") {
    violations.push("enumValues: the enum expectation could not be built");
  } else {
    const expectedValues = Object.entries(expectation.enums.enums).flatMap(([name, values]) => values.map((value, i) => ({ schema: "public", enum: name, value, position: i + 1 })));
    violations.push(...exactSectionViolations(fingerprint, "enumValues", expectedValues));
  }

  // types（exact。テーブルの行型と配列型、enum とその配列型。所有者は katana_test_user、ACL は未設定）
  const typeRow = (name: string, kind: string) => ({ schema: "public", name, kind, owner: EXPECTED_USER, acl: null });
  const enums = [...expectation.inventory.enums];
  violations.push(
    ...exactSectionViolations(fingerprint, "types", [
      ...tables.flatMap((t) => [typeRow(t, "c"), typeRow(`_${t}`, "b")]),
      ...enums.flatMap((e) => [typeRow(e, "e"), typeRow(`_${e}`, "b")]),
    ]),
  );

  // relations（partial）
  const relations = sectionRows(fingerprint, "relations");
  const tableRows = relations.filter((r) => r.kind === "r");
  const indexRows = relations.filter((r) => r.kind === "i");
  const sequenceRows = relations.filter((r) => r.kind === "S");
  const otherRows = relations.filter((r) => r.kind !== "r" && r.kind !== "i" && r.kind !== "S");
  const flagsOk = (r: CreatedRow) => r.schema === "public" && r.persistence === "p" && r.rowSecurity === false && r.forceRowSecurity === false && r.owner === EXPECTED_USER;
  const tableNames = tableRows.map((r) => String(r.name)).sort(compareCodePoints);
  if (tableNames.join(",") !== [...tables].sort(compareCodePoints).join(",")) violations.push("relations: the tables are not exactly the expected ones");
  const badTables = tableRows.filter((r) => !flagsOk(r) || !sameCanonicalAcl(r.acl, EXPECTED_TABLE_ACL_AFTER_GRANT)).length;
  if (badTables > 0) violations.push(`relations: ${badTables} table(s) without the expected owner, flags or ACL after creation`);
  if (sequenceRows.length !== EXPECTED_SEQUENCE_COUNT) violations.push(`relations: ${sequenceRows.length} sequence(s)`);
  if (otherRows.length > 0) violations.push(`relations: ${otherRows.length} relation(s) of other kinds`);
  // インデックスの行（invariants）：所有者・フラグ・ACL が未設定・indexes の区分と同じ名前の集合。名前・件数そのものは確かめない
  const badIndexes = indexRows.filter((r) => !flagsOk(r) || r.acl !== null).length;
  if (badIndexes > 0) violations.push(`relations: ${badIndexes} index row(s) without the expected owner, flags or empty ACL`);

  // indexes（invariants）：期待するテーブルの public のインデックスで、valid。名前・件数・定義は確かめない
  const indexes = sectionRows(fingerprint, "indexes");
  const badIndexDefinitions = indexes.filter((r) => r.schema !== "public" || !tableSet.has(String(r.table)) || r.valid !== true).length;
  if (badIndexDefinitions > 0) violations.push(`indexes: ${badIndexDefinitions} index(es) outside the expected tables or not valid`);
  const relationIndexNames = indexRows.map((r) => String(r.name)).sort(compareCodePoints).join(",");
  const indexNames = indexes.map((r) => String(r.name)).sort(compareCodePoints).join(",");
  if (relationIndexNames !== indexNames) violations.push("relations: the index rows do not match the indexes section");

  // columns（invariants）：期待するテーブルの列だけ・すべてのテーブルに列がある・列単位の ACL がない。定義は確かめない
  const columns = sectionRows(fingerprint, "columns");
  const badColumns = columns.filter((r) => r.schema !== "public" || !tableSet.has(String(r.table)) || r.acl !== null).length;
  if (badColumns > 0) violations.push(`columns: ${badColumns} column(s) outside the expected tables or with their own ACL`);
  const tablesWithColumns = new Set(columns.map((r) => String(r.table)));
  const withoutColumns = tables.filter((t) => !tablesWithColumns.has(t)).length;
  if (withoutColumns > 0) violations.push(`columns: ${withoutColumns} expected table(s) without columns`);

  // constraints（invariants）：期待するテーブルの主キー・外部キー・一意制約だけ。名前・件数・定義は確かめない
  const constraints = sectionRows(fingerprint, "constraints");
  const badConstraints = constraints.filter((r) => r.schema !== "public" || !tableSet.has(String(r.table)) || !["p", "f", "u"].includes(String(r.type))).length;
  if (badConstraints > 0) violations.push(`constraints: ${badConstraints} constraint(s) outside the expected tables or of other types`);

  return violations;
}

/** A1：作成後の ACL の照合（A0 と同じ固定の SELECT の観測を、katana_test だけ作成後の期待値にして比べる） */
export function createdAclViolations(observation: PreChangeAclObservation): string[] {
  return preChangeAclViolations(observation, "grant-sync");
}
