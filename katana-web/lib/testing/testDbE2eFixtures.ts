import path from "node:path";
import {
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import {
  EXPECTED_DATABASE,
  EXPECTED_USER,
  IntegrationDatabaseCheckError,
  type IntegrationDbClient,
  safeErrorCode,
  select,
  TEST_DATABASE_MARKER,
} from "./integrationDatabaseCheck.ts";
import { DEVELOPMENT_ENV_FILE, TEST_ENV_FILE } from "./integrationEnv.ts";
import { serverIdentityChanges, serverIdentityMismatches } from "./testDbIdentity.ts";
import { pinSearchPath, type TestDatabaseInspection } from "./testDbState.ts";

/**
 * F-01 の E2E 用のテストデータの準備と、シナリオごとの DB の変更（scripts/testdb-e2e.mts の本体。Step 4-13C。方式 D1）。
 *
 *   npm run testdb:e2e                         … 操作の一覧の表示だけ（DB・Docker に触れない）
 *   npm run testdb:e2e -- --op <操作>          … 予行。検証と、実行予定の SQL の種類・件数の表示だけ（DB に接続しない）
 *   npm run testdb:e2e -- --op <操作> --apply  … 実行の意思表示。固定のゲート（fixtures）が有効なときだけ、1つの操作を1回だけ行う。
 *                                                今はゲートが無効なので、検証の後、DB に接続する前に E2E_FIXTURE_LIVE_DISABLED で止まる
 *
 * 操作は固定の名前だけで、SQL は固定の文字列（値は固定の ID などを引数で渡す。外から SQL・値を渡す経路はない）。
 * 外部とのやりとり（env ファイルの読み込み、パスワードのハッシュ、読み取り専用の検査、接続、表示）は、すべて引数で受け取る。
 * このモジュールは DB ドライバ・Prisma・Docker・子プロセスを読み込まない。
 *
 * `--apply` の順序（最初の失敗で止まる。再試行・修復・次の操作への自動の移行はしない）:
 * 1. 引数・Node の起動オプション・`.env.test` の接続先とパスワード・親の PG*・DOTENV_*（seed は `.env.e2e` のパスワードも）
 * 2. 9つ目の固定ゲート（fixtures）。無効なら、ここで止まる（読み取り専用の検査も接続もしない）
 * 3. 読み取り専用の検査（inspectDatabase）：本人確認・状態・サーバーの識別情報。seed は状態 C、それ以外は「データがあるだけの B」を要求する
 * 4. 書き込みの接続（1回）：BEGIN → search_path を pg_catalog に固定 → 本人確認 → 固定の SQL（それぞれ RETURNING で、期待する件数と完全に一致）→ COMMIT。
 *    途中で失敗したら ROLLBACK して接続を閉じる（何も変更しない）
 * 5. 読み取り専用の検査をもう一度：「データがあるだけの B」で、サーバーの識別情報が 3 と同じであること
 *
 * TRUNCATE・DROP・ALTER・GRANT・migration・Docker の操作はしない。削除は E2E-03 のユーザー1件（取り込み履歴がないことを条件にする）だけ。
 * E2E の後のテストデータは、SQL で消さずに、テストDB を作り直して戻す（docs/TESTING.md の6章）。
 * 表示・例外のメッセージには、接続URL・パスワード・パスワードのハッシュを含めない。
 */

/** E2E 用のユーザーのパスワードを置くファイル（`.env*` なので Git の対象外。`.env.test` は決まった3つのキーしか置けないため、別にする） */
export const E2E_ENV_FILE = ".env.e2e";
export const E2E_USER_PASSWORD_KEY = "KATANA_E2E_USER_PASSWORD";
export const E2E_USER_PASSWORD_MIN_LENGTH = 16;
const PASSWORD_CHARSET = /^[A-Za-z0-9_-]+$/;
const PASSWORD_PLACEHOLDER = /change[_-]?me/i;

/**
 * E2E のテストデータの準備・変更の許可（9つ目の固定ゲート）。scripts/testdb-e2e.mts は E2E_FIXTURE_DISABLED を固定で渡す。
 * 環境変数・引数（`--apply` を含む）では変えられない。有効にするには、承認を得てスクリプトのコードを変え、commit する。
 */
export type E2eFixtureAccess = { readonly mode: "disabled" } | { readonly mode: "enabled" };
export const E2E_FIXTURE_DISABLED: E2eFixtureAccess = Object.freeze({ mode: "disabled" });

/** 固定の ID（UUID の形。E2E のデータだけに使う） */
export const E2E_IDS = Object.freeze({
  category: "00000000-0000-4000-8e2e-000000000001",
  swordEra: "00000000-0000-4000-8e2e-000000000002",
  shopA: "00000000-0000-4000-8e2e-0000000000a1",
  shopB: "00000000-0000-4000-8e2e-0000000000b1",
  shopC: "00000000-0000-4000-8e2e-0000000000c1",
  shopD: "00000000-0000-4000-8e2e-0000000000d1",
  userE2e01: "00000000-0000-4000-8e2e-000000000101",
  userE2e03: "00000000-0000-4000-8e2e-000000000103",
  userE2e04: "00000000-0000-4000-8e2e-000000000104",
  userE2e05: "00000000-0000-4000-8e2e-000000000105",
  userE2e06ja: "00000000-0000-4000-8e2e-000000000161",
  userE2e06en: "00000000-0000-4000-8e2e-000000000162",
  userShopB: "00000000-0000-4000-8e2e-0000000001b1",
  productA1: "00000000-0000-4000-8e2e-000000000a01",
  productB1: "00000000-0000-4000-8e2e-000000000b01",
  productB2: "00000000-0000-4000-8e2e-000000000b02",
  productC1: "00000000-0000-4000-8e2e-000000000c01",
  importJobA: "00000000-0000-4000-8e2e-000000001a01",
  importRowA: "00000000-0000-4000-8e2e-000000002a01",
  importJobB: "00000000-0000-4000-8e2e-000000001b01",
});

/** E2E でログインに使うアカウント（メールアドレスだけ。パスワードは `.env.e2e` の値で、表示しない） */
export const E2E_LOGIN_ACCOUNTS = Object.freeze({
  e2e01: { email: "e2e-01@example.invalid", shop: "A", role: "STORE", scenario: "E2E-01・02" },
  e2e03: { email: "e2e-03@example.invalid", shop: "C", role: "STORE", scenario: "E2E-03（取り込み履歴なし。削除される）" },
  e2e04: { email: "e2e-04@example.invalid", shop: "C", role: "STORE", scenario: "E2E-04（店舗B へ移される）" },
  e2e05: { email: "e2e-05@example.invalid", shop: "C", role: "ADMIN", scenario: "E2E-05（STORE へ変えられる）" },
  e2e06ja: { email: "e2e-06-ja@example.invalid", shop: "D", role: "STORE", scenario: "E2E-06（ja）" },
  e2e06en: { email: "e2e-06-en@example.invalid", shop: "D", role: "STORE", scenario: "E2E-06（en）" },
} as const);

type Statement = { sql: string; params: readonly unknown[]; expectRows: number; label: string };

const NOW = "pg_catalog.now()";
const T = (table: string) => `"public"."${table}"`;

function insertCategory(table: "Category" | "SwordEra", id: string, name: string): Statement {
  return {
    label: `insert ${table}`,
    sql: `INSERT INTO ${T(table)} ("id", "name", "displayOrder", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, 0, true, ${NOW}, ${NOW}) RETURNING "id"`,
    params: [id, name],
    expectRows: 1,
  };
}
function insertShop(id: string, name: string): Statement {
  return {
    label: "insert Shop",
    sql: `INSERT INTO ${T("Shop")} ("id", "name", "isActive", "nextProductSequence", "createdAt", "updatedAt") VALUES ($1, $2, true, 100, ${NOW}, ${NOW}) RETURNING "id"`,
    params: [id, name],
    expectRows: 1,
  };
}
function insertUser(id: string, name: string, email: string, passwordHash: string, role: "STORE" | "ADMIN", shopId: string): Statement {
  return {
    label: "insert User",
    sql: `INSERT INTO ${T("User")} ("id", "name", "email", "password", "role", "shopId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, ${NOW}, ${NOW}) RETURNING "id"`,
    params: [id, name, email, passwordHash, role, shopId],
    expectRows: 1,
  };
}
function insertProduct(id: string, shopId: string, productCode: string, title: string, price: number): Statement {
  return {
    label: "insert Product",
    sql:
      `INSERT INTO ${T("Product")} ("id", "shopId", "productCode", "title", "categoryId", "swordEraId", "price", "status", "listedAt", "createdAt", "updatedAt") ` +
      `VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', ${NOW}, ${NOW}, ${NOW}) RETURNING "id"`,
    params: [id, shopId, productCode, title, E2E_IDS.category, E2E_IDS.swordEra, price],
    expectRows: 1,
  };
}

/** seed：E2E-01〜06 のデータ（状態 C の空のテストDB に入れる） */
export function seedStatements(passwordHash: string): Statement[] {
  const I = E2E_IDS;
  const A = E2E_LOGIN_ACCOUNTS;
  return [
    insertCategory("Category", I.category, "E2E刀種"),
    insertCategory("SwordEra", I.swordEra, "E2E区分"),
    insertShop(I.shopA, "E2E店舗A"),
    insertShop(I.shopB, "E2E店舗B"),
    insertShop(I.shopC, "E2E店舗C"),
    insertShop(I.shopD, "E2E店舗D"),
    insertUser(I.userE2e01, "E2E利用者01", A.e2e01.email, passwordHash, "STORE", I.shopA),
    insertUser(I.userE2e03, "E2E利用者03", A.e2e03.email, passwordHash, "STORE", I.shopC),
    insertUser(I.userE2e04, "E2E利用者04", A.e2e04.email, passwordHash, "STORE", I.shopC),
    insertUser(I.userE2e05, "E2E利用者05", A.e2e05.email, passwordHash, "ADMIN", I.shopC),
    insertUser(I.userE2e06ja, "E2E利用者06ja", A.e2e06ja.email, passwordHash, "STORE", I.shopD),
    insertUser(I.userE2e06en, "E2E利用者06en", A.e2e06en.email, passwordHash, "STORE", I.shopD),
    insertUser(I.userShopB, "E2E店舗Bの利用者", "e2e-shop-b@example.invalid", passwordHash, "STORE", I.shopB),
    insertProduct(I.productA1, I.shopA, "E2E-A-001", "E2E商品A-001", 1_000_000),
    insertProduct(I.productB1, I.shopB, "E2E-B-001", "E2E商品B-001", 2_000_000),
    insertProduct(I.productB2, I.shopB, "E2E-B-002", "E2E商品B-002", 3_000_000),
    insertProduct(I.productC1, I.shopC, "E2E-C-001", "E2E商品C-001", 4_000_000),
    {
      label: "insert ImportJob (shop A, PENDING)",
      sql:
        `INSERT INTO ${T("ImportJob")} ("id", "shopId", "fileName", "status", "totalRows", "successRows", "errorRows", "executedById", "createdAt") ` +
        `VALUES ($1, $2, $3, 'PENDING', 1, 1, 0, $4, ${NOW}) RETURNING "id"`,
      params: [I.importJobA, I.shopA, "e2e-shop-a.csv", I.userE2e01],
      expectRows: 1,
    },
    {
      label: "insert ImportRow (shop A)",
      sql: `INSERT INTO ${T("ImportRow")} ("id", "importJobId", "rowNumber", "productCode", "status", "createdAt") VALUES ($1, $2, 2, $3, 'SUCCESS', ${NOW}) RETURNING "id"`,
      params: [I.importRowA, I.importJobA, "E2E-A-002"],
      expectRows: 1,
    },
    {
      label: "insert ImportJob (shop B, COMPLETED)",
      sql:
        `INSERT INTO ${T("ImportJob")} ("id", "shopId", "fileName", "status", "totalRows", "successRows", "errorRows", "executedById", "startedAt", "completedAt", "createdAt") ` +
        `VALUES ($1, $2, $3, 'COMPLETED', 2, 2, 0, $4, ${NOW}, ${NOW}, ${NOW}) RETURNING "id"`,
      params: [I.importJobB, I.shopB, "e2e-shop-b.csv", I.userShopB],
      expectRows: 1,
    },
  ];
}

function setShopActive(shopId: string, active: boolean): Statement {
  return {
    label: `${active ? "activate" : "deactivate"} Shop`,
    // 今の値が逆のときだけ変える（同じ操作を2回しても、2回目は 0 件で失敗する）
    sql: `UPDATE ${T("Shop")} SET "isActive" = $2, "updatedAt" = ${NOW} WHERE "id" = $1 AND "isActive" = $3 RETURNING "id"`,
    params: [shopId, active, !active],
    expectRows: 1,
  };
}

export type E2eFixtureOperation = {
  description: string;
  /** seed は状態 C の空の DB、それ以外は seed の後の「データがあるだけの B」 */
  requires: "empty" | "seeded";
  needsPassword: boolean;
  statements: (passwordHash: string | undefined) => Statement[];
};

export const E2E_FIXTURE_OPERATIONS: Readonly<Record<string, E2eFixtureOperation>> = Object.freeze({
  seed: {
    description: "E2E-01〜06 のデータ（店舗4つ・ユーザー7人・商品4件・取り込み2件・マスタ2件）を、空のテストDB に入れる",
    requires: "empty",
    needsPassword: true,
    statements: (hash) => seedStatements(hash as string),
  },
  "e2e01-deactivate-shop-a": {
    description: "E2E-01：店舗A を無効にする",
    requires: "seeded",
    needsPassword: false,
    statements: () => [setShopActive(E2E_IDS.shopA, false)],
  },
  "e2e02-activate-shop-a": {
    description: "E2E-02：店舗A を有効に戻す",
    requires: "seeded",
    needsPassword: false,
    statements: () => [setShopActive(E2E_IDS.shopA, true)],
  },
  "e2e03-delete-user": {
    description: "E2E-03：取り込み履歴のないユーザー e2e-03 を削除する",
    requires: "seeded",
    needsPassword: false,
    statements: () => [
      {
        label: "delete User (no import history)",
        sql:
          `DELETE FROM ${T("User")} WHERE "id" = $1 ` +
          `AND NOT EXISTS (SELECT 1 FROM ${T("ImportJob")} j WHERE j."executedById" = $1) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${T("ProductHistory")} h WHERE h."changedById" = $1) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${T("Product")} p WHERE p."createdById" = $1 OR p."updatedById" = $1 OR p."deletedById" = $1) RETURNING "id"`,
        params: [E2E_IDS.userE2e03],
        expectRows: 1,
      },
    ],
  },
  "e2e04-move-user-to-shop-b": {
    description: "E2E-04：ユーザー e2e-04 の所属を店舗C から店舗B に変える",
    requires: "seeded",
    needsPassword: false,
    statements: () => [
      {
        label: "move User to shop B",
        sql: `UPDATE ${T("User")} SET "shopId" = $2, "updatedAt" = ${NOW} WHERE "id" = $1 AND "shopId" = $3 RETURNING "id"`,
        params: [E2E_IDS.userE2e04, E2E_IDS.shopB, E2E_IDS.shopC],
        expectRows: 1,
      },
    ],
  },
  "e2e05-demote-admin": {
    description: "E2E-05：ユーザー e2e-05 のロールを ADMIN から STORE に変える",
    requires: "seeded",
    needsPassword: false,
    statements: () => [
      {
        label: "demote User to STORE",
        sql: `UPDATE ${T("User")} SET "role" = 'STORE', "updatedAt" = ${NOW} WHERE "id" = $1 AND "role" = 'ADMIN' RETURNING "id"`,
        params: [E2E_IDS.userE2e05],
        expectRows: 1,
      },
    ],
  },
  "e2e06-deactivate-shop-d": {
    description: "E2E-06：店舗D を無効にする（ja・en の両方のユーザーが所属）",
    requires: "seeded",
    needsPassword: false,
    statements: () => [setShopActive(E2E_IDS.shopD, false)],
  },
});

export type E2eFixtureErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "E2E_PASSWORD_MISSING"
  | "E2E_PASSWORD_REJECTED"
  | "E2E_FIXTURE_LIVE_DISABLED"
  | "INSPECTION_FAILED"
  | "STATE_NOT_ALLOWED"
  | "SERVER_IDENTITY_MISMATCH"
  | "WRITE_FAILED"
  | "UNEXPECTED_ROW_COUNT"
  | "POST_CHECK_FAILED";

export class E2eFixtureError extends Error {
  readonly code: E2eFixtureErrorCode;

  constructor(code: E2eFixtureErrorCode, detail: string) {
    super(`[testdb-e2e] ${code}: ${detail}`);
    this.name = "E2eFixtureError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type E2eFixtureCommand = { mode: "list" } | { mode: "dry-run" | "apply"; operation: string };

export function parseE2eFixtureArgs(args: readonly string[]): E2eFixtureCommand {
  if (args.length === 0) return { mode: "list" };
  const known = (name: string | undefined) => name !== undefined && Object.hasOwn(E2E_FIXTURE_OPERATIONS, name);
  if (args.length === 2 && args[0] === "--op" && known(args[1])) return { mode: "dry-run", operation: args[1] };
  if (args.length === 3 && args[0] === "--op" && known(args[1]) && args[2] === "--apply") return { mode: "apply", operation: args[1] };
  throw new E2eFixtureError("ARGUMENTS_INVALID", `use --op <operation> [--apply]; operations: ${Object.keys(E2E_FIXTURE_OPERATIONS).join(", ")}.`);
}

/**
 * `.env.e2e`（dotenv.parse した結果）の E2E 用のユーザーのパスワードを検証する。キーは KATANA_E2E_USER_PASSWORD だけ。
 * 16文字以上・使える文字（`[A-Za-z0-9_-]`）だけ・見本の値でない・テストDB のパスワードと違うこと。値は返すだけで表示しない。
 */
export function assertE2eUserPassword(e2eEnv: EnvSource | undefined, testPasswords: readonly string[]): string {
  if (e2eEnv === undefined) throw new E2eFixtureError("E2E_PASSWORD_MISSING", `${E2E_ENV_FILE} was not found; create it with ${E2E_USER_PASSWORD_KEY}.`);
  const unexpected = Object.keys(e2eEnv).filter((key) => key !== E2E_USER_PASSWORD_KEY);
  if (unexpected.length > 0) throw new E2eFixtureError("E2E_PASSWORD_REJECTED", `${E2E_ENV_FILE} has unexpected keys: ${unexpected.sort().join(", ")}.`);
  const value = e2eEnv[E2E_USER_PASSWORD_KEY];
  if (value === undefined || value === "") throw new E2eFixtureError("E2E_PASSWORD_MISSING", `${E2E_USER_PASSWORD_KEY} is not set in ${E2E_ENV_FILE}.`);
  if (PASSWORD_PLACEHOLDER.test(value)) throw new E2eFixtureError("E2E_PASSWORD_REJECTED", "the E2E user password still has a placeholder value.");
  if (!PASSWORD_CHARSET.test(value)) throw new E2eFixtureError("E2E_PASSWORD_REJECTED", "the E2E user password may only contain A-Z, a-z, 0-9, '_' and '-'.");
  if (value.length < E2E_USER_PASSWORD_MIN_LENGTH) {
    throw new E2eFixtureError("E2E_PASSWORD_REJECTED", `the E2E user password must be at least ${E2E_USER_PASSWORD_MIN_LENGTH} characters.`);
  }
  if (testPasswords.includes(value)) throw new E2eFixtureError("E2E_PASSWORD_REJECTED", "the E2E user password must differ from the test database passwords.");
  return value;
}

/** 書き込みのトランザクションの中の本人確認（読み取り専用ではないので、assertDatabaseIdentity の read-only の確認は使えない） */
export const WRITE_IDENTITY_SQL = `SELECT pg_catalog.current_database()::text AS "database", current_user::text AS "currentUser",
       session_user::text AS "sessionUser", pg_catalog.shobj_description(d.oid, 'pg_database') AS "marker"
  FROM pg_catalog.pg_database d WHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`;

async function assertWriteIdentity(client: IntegrationDbClient): Promise<void> {
  const rows = await select(client, "identity query", WRITE_IDENTITY_SQL);
  const [row] = rows;
  const ok =
    rows.length === 1 &&
    row.database === EXPECTED_DATABASE &&
    row.currentUser === EXPECTED_USER &&
    row.sessionUser === EXPECTED_USER &&
    row.marker === TEST_DATABASE_MARKER;
  if (!ok) throw new IntegrationDatabaseCheckError("IDENTITY_UNAVAILABLE", "the write connection is not the test database.");
}

/** seed の後の状態：テーブルにデータがあるだけの B（migration の不一致など、ほかの理由がない） */
export function isSeededOnly(inspection: TestDatabaseInspection): boolean {
  const { state } = inspection;
  return state.state === "B" && state.reasons.length === 1 && state.reasons[0].startsWith("tables are not empty: ");
}

export type E2eFixtureDeps = {
  root: string;
  argv: readonly string[];
  execArgv: readonly string[];
  parentEnv: EnvSource;
  readEnvFile: (filePath: string) => Record<string, string> | undefined;
  /** bcrypt のハッシュ（scripts/testdb-e2e.mts は bcryptjs を渡す。ログインの照合と同じ方式） */
  hashPassword: (password: string) => string;
  /** 9つ目の固定ゲート。scripts/testdb-e2e.mts は E2E_FIXTURE_DISABLED を固定で渡す */
  fixtures: E2eFixtureAccess;
  /** ゲートが有効なときだけ呼ぶ：読み取り専用の検査（createTestDatabaseInspector） */
  inspectDatabase: (input: { databaseUrl: string; developmentDatabaseUrl: string | undefined }) => Promise<TestDatabaseInspection>;
  /** ゲートが有効なときだけ呼ぶ：書き込みの接続（connectTestDatabase） */
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
  log: (text: string) => void;
};

async function inspectOrStop(deps: E2eFixtureDeps, input: { databaseUrl: string; developmentDatabaseUrl: string | undefined }, code: E2eFixtureErrorCode) {
  try {
    return await deps.inspectDatabase(input);
  } catch (error) {
    const inner = error instanceof IntegrationDatabaseCheckError ? error.code : "unknown";
    throw new E2eFixtureError(code, `the read-only inspection of the test database failed (${inner}). Nothing was changed.`);
  }
}

/** 1回の接続・1つのトランザクションで固定の SQL を実行する。どれか1つでも失敗・件数の不一致なら ROLLBACK する */
async function runWrite(deps: E2eFixtureDeps, databaseUrl: string, statements: readonly Statement[]): Promise<number> {
  let client: IntegrationDbClient;
  try {
    client = await deps.connect(databaseUrl);
  } catch (error) {
    throw new E2eFixtureError("WRITE_FAILED", `could not connect to the test database (${safeErrorCode(error)}). Nothing was changed.`);
  }
  let began = false;
  let failure: unknown;
  let changed = 0;
  try {
    await client.query("BEGIN");
    began = true;
    await pinSearchPath(client);
    await assertWriteIdentity(client);
    for (const statement of statements) {
      let rows: Record<string, unknown>[];
      try {
        rows = (await client.query(statement.sql, statement.params)).rows;
      } catch (error) {
        throw new E2eFixtureError("WRITE_FAILED", `${statement.label} failed (${safeErrorCode(error)}).`);
      }
      if (rows.length !== statement.expectRows) {
        throw new E2eFixtureError("UNEXPECTED_ROW_COUNT", `${statement.label} affected ${rows.length} row(s), expected ${statement.expectRows}.`);
      }
      changed += rows.length;
    }
    await client.query("COMMIT");
    began = false;
  } catch (error) {
    failure = error;
  }
  if (began) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK に失敗しても、接続を閉じればトランザクションは破棄される。最初の失敗を優先して報告する
    }
  }
  try {
    await client.end();
  } catch {
    // 接続を閉じる失敗は、最初の失敗がなければ下で報告する
    failure ??= new E2eFixtureError("WRITE_FAILED", "the connection could not be closed.");
  }
  if (failure !== undefined) {
    if (failure instanceof E2eFixtureError) throw new E2eFixtureError(failure.code, `${failure.message.replace(/^\[testdb-e2e\] [A-Z_]+: /, "")} The transaction was rolled back; nothing was changed.`);
    if (failure instanceof IntegrationDatabaseCheckError) {
      throw new E2eFixtureError("WRITE_FAILED", `the write connection check failed (${failure.code}). The transaction was rolled back; nothing was changed.`);
    }
    throw new E2eFixtureError("WRITE_FAILED", `the write failed (${safeErrorCode(failure)}). The transaction was rolled back; nothing was changed.`);
  }
  return changed;
}

function verifyTestEnv(deps: E2eFixtureDeps): { databaseUrl: string; developmentDatabaseUrl: string | undefined; target: TestDatabaseTarget; testPasswords: string[] } {
  const testEnv = deps.readEnvFile(path.join(deps.root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new E2eFixtureError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentDatabaseUrl = deps.readEnvFile(path.join(deps.root, DEVELOPMENT_ENV_FILE))?.DATABASE_URL;
  let target: TestDatabaseTarget;
  try {
    target = assertTestDatabaseTarget({ databaseUrl: testEnv.DATABASE_URL, env: {}, developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new E2eFixtureError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    throw error;
  }
  let passwords: { appPassword: string; adminPassword: string };
  try {
    passwords = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) throw new E2eFixtureError("CREDENTIALS_REJECTED", `the credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    throw error;
  }
  // この process の pg は PG* を読むので、親の PG*・DOTENV_* を拒否する（testdb-migrate と同じ）
  try {
    assertTestDatabaseTarget({ databaseUrl: testEnv.DATABASE_URL, env: deps.parentEnv, developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw new E2eFixtureError("UNSAFE_PARENT_ENV", `the environment of this process was rejected (${error.code}).`);
    throw error;
  }
  return { databaseUrl: testEnv.DATABASE_URL as string, developmentDatabaseUrl, target, testPasswords: [passwords.appPassword, passwords.adminPassword] };
}

export async function runTestDbE2e(deps: E2eFixtureDeps): Promise<number> {
  const command = parseE2eFixtureArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new E2eFixtureError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new E2eFixtureError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running this script.");
  }

  if (command.mode === "list") {
    deps.log(
      [
        "[testdb-e2e] operations (nothing was read or changed):",
        ...Object.entries(E2E_FIXTURE_OPERATIONS).map(([name, op]) => `  ${name}: ${op.description}`),
        "",
        "use --op <operation> for a dry run, and --op <operation> --apply to run it (the fixture gate must be enabled).",
      ].join("\n"),
    );
    return 0;
  }

  const operation = E2E_FIXTURE_OPERATIONS[command.operation];
  const env = verifyTestEnv(deps);
  let password: string | undefined;
  if (operation.needsPassword) {
    password = assertE2eUserPassword(deps.readEnvFile(path.join(deps.root, E2E_ENV_FILE)), env.testPasswords);
  }
  // 予行では、ハッシュも作らずに、SQL の種類と件数だけを表示する
  const planned = operation.statements(password === undefined ? undefined : "(hash not computed in the dry run)");
  const plan = [
    `operation: ${command.operation} — ${operation.description}`,
    `connection target: verified ${env.target.host}:${env.target.port}/${env.target.database} as ${env.target.user} (password hidden)`,
    `requires: ${operation.requires === "empty" ? "state C (empty tables)" : "seeded data only (state B with only non-empty tables)"}`,
    `statements: ${planned.length} (${planned.map((s) => s.label).join("; ")})`,
    ...(operation.needsPassword ? [`E2E user password: verified (${E2E_ENV_FILE}; value hidden)`] : []),
    `fixture gate: ${deps.fixtures.mode === "enabled" ? "enabled" : "disabled in this build (--apply stops with E2E_FIXTURE_LIVE_DISABLED before connecting)"}`,
  ];

  if (command.mode === "dry-run") {
    deps.log(["[testdb-e2e] dry run (--apply was not given): no database connection was made and nothing was changed.", "", ...plan].join("\n"));
    return 0;
  }

  // 9つ目の固定ゲート。「enabled」と完全に一致しなければ、検査も接続もしない
  if (deps.fixtures.mode !== "enabled") {
    throw new E2eFixtureError("E2E_FIXTURE_LIVE_DISABLED", "the E2E fixture gate is disabled in this build (--apply alone does not enable it); refusing to connect to the test database.");
  }

  const input = { databaseUrl: env.databaseUrl, developmentDatabaseUrl: env.developmentDatabaseUrl };
  const before = await inspectOrStop(deps, input, "INSPECTION_FAILED");
  const allowed = operation.requires === "empty" ? before.state.state === "C" : isSeededOnly(before);
  if (!allowed) {
    throw new E2eFixtureError("STATE_NOT_ALLOWED", `the test database is not in the required state for ${command.operation} (state ${String(before.state.state)}). Nothing was changed.`);
  }
  const mismatches = serverIdentityMismatches(before.server);
  if (mismatches.length > 0) throw new E2eFixtureError("SERVER_IDENTITY_MISMATCH", `the server identity is unexpected (${mismatches.join("; ")}). Nothing was changed.`);

  const statements = operation.statements(password === undefined ? undefined : deps.hashPassword(password));
  const changed = await runWrite(deps, env.databaseUrl, statements);

  const after = await inspectOrStop(deps, input, "POST_CHECK_FAILED");
  const changes = serverIdentityChanges(before.server, after.server);
  if (changes.length > 0 || !isSeededOnly(after)) {
    throw new E2eFixtureError(
      "POST_CHECK_FAILED",
      `the check after ${command.operation} failed (${changes.length > 0 ? `server changed: ${changes.join(", ")}` : `state ${String(after.state.state)}`}). The change was committed; nothing was repaired.`,
    );
  }
  deps.log(["[testdb-e2e] applied: the change was committed and checked.", "", ...plan, `rows changed: ${changed}`].join("\n"));
  return 0;
}
