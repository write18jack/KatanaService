/**
 * テスト専用DB以外への接続を、接続前に止めるための検証関数。
 *
 * runner・globalSetup・lib/prisma.ts・migration用スクリプトから共通で使うため、
 * 副作用を持たず、外部モジュールや `@/` エイリアスも読み込まない。
 * `.env` の読み込みなどは呼び出し側で行い、結果を引数で渡す。
 *
 * エラーメッセージにはパスワードや接続URLの全文を含めない。
 */

/** 許可する唯一の接続先 */
export const TEST_DATABASE_TARGET = {
  hosts: ["127.0.0.1", "localhost"],
  port: "5434",
  database: "katana_test",
  user: "katana_test_user",
} as const;

export type TestDatabaseGuardErrorCode =
  | "URL_MISSING"
  | "URL_INVALID"
  | "SCHEME_NOT_POSTGRES"
  | "HOST_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "DATABASE_NOT_ALLOWED"
  | "USER_NOT_ALLOWED"
  | "PASSWORD_MISSING"
  | "QUERY_NOT_ALLOWED"
  | "MATCHES_DEVELOPMENT_DATABASE"
  | "DEVELOPMENT_URL_INVALID"
  | "PG_ENV_PRESENT"
  | "DOTENV_ENV_PRESENT";

export class TestDatabaseGuardError extends Error {
  readonly code: TestDatabaseGuardErrorCode;

  constructor(code: TestDatabaseGuardErrorCode, detail: string) {
    super(`[testDatabaseGuard] ${code}: ${detail}`);
    this.name = "TestDatabaseGuardError";
    this.code = code;
  }
}

export type TestDatabaseGuardInput = {
  /** 検証する接続URL（通常は子プロセスに渡す DATABASE_URL） */
  databaseUrl: string | undefined;
  /** 接続先を変え得る環境変数を検査する対象（通常は process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * 開発用DBの接続URL（呼び出し側が `.env` を dotenv.parse して渡す）。
   * `.env` が存在しない環境では undefined を渡す。その場合も、ホスト・ポート・DB名・ユーザーの条件で開発用DBは拒否される。
   */
  developmentDatabaseUrl: string | undefined;
};

/** 表示してよい接続先の情報（パスワードを含まない） */
export type TestDatabaseTarget = {
  host: string;
  port: string;
  database: string;
  user: string;
};

/** libpq・node-postgres が参照する PG* と、dotenv の読み込み先・上書き動作を変える DOTENV_* */
const PG_ENV_PATTERN = /^PG/;
const DOTENV_ENV_PATTERN = /^DOTENV_/;
const POSTGRES_PROTOCOLS = ["postgres:", "postgresql:"];
const LOOPBACK_HOSTS: readonly string[] = TEST_DATABASE_TARGET.hosts;

/** URL全体を返さず、検証に必要な要素だけを取り出す。解析できなければ null */
function parsePostgresUrl(value: string): { url: URL } | null {
  // 空白・制御文字は URL の解析時に除去・正規化されるため、含んでいれば拒否する
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    return { url: new URL(value) };
  } catch {
    return null;
  }
}

/** 開発用DBと同じ接続先か（ループバックのホスト名の違いは同一とみなす） */
function pointsToSameDatabase(a: URL, b: URL): boolean {
  const sameHost =
    a.hostname === b.hostname || (LOOPBACK_HOSTS.includes(a.hostname) && LOOPBACK_HOSTS.includes(b.hostname));
  return sameHost && a.port === b.port && a.pathname === b.pathname;
}

/**
 * 接続URLと環境変数を検証する。条件を1つでも満たさなければ TestDatabaseGuardError を投げる。
 * DBには接続しない。成功時は、表示してよい接続先の情報を返す。
 */
export function assertTestDatabaseTarget(input: TestDatabaseGuardInput): TestDatabaseTarget {
  return assertTargetForUser(input, TEST_DATABASE_TARGET.user);
}

/** schemaDiff 用の読み取り専用ロール（Step 3-12B-5E-3） */
export const READ_ONLY_TEST_DATABASE_USER = "katana_test_ro";

/**
 * 読み取り専用ロール（katana_test_ro）の接続URLを検証する。
 * 条件は assertTestDatabaseTarget と同じで、ユーザーだけが katana_test_ro に固定される（TEST_DATABASE_TARGET は緩めない）。
 */
export function assertReadOnlyTestDatabaseTarget(input: TestDatabaseGuardInput): TestDatabaseTarget {
  return assertTargetForUser(input, READ_ONLY_TEST_DATABASE_USER);
}

function assertTargetForUser(input: TestDatabaseGuardInput, expectedUser: string): TestDatabaseTarget {
  const { databaseUrl, env, developmentDatabaseUrl } = input;

  if (databaseUrl === undefined || databaseUrl === "") {
    throw new TestDatabaseGuardError("URL_MISSING", "DATABASE_URL is not set.");
  }

  const parsed = parsePostgresUrl(databaseUrl);
  if (!parsed) {
    throw new TestDatabaseGuardError("URL_INVALID", "DATABASE_URL could not be parsed as a URL.");
  }
  const { url } = parsed;

  if (!POSTGRES_PROTOCOLS.includes(url.protocol)) {
    throw new TestDatabaseGuardError("SCHEME_NOT_POSTGRES", `scheme "${url.protocol}" is not allowed.`);
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new TestDatabaseGuardError("HOST_NOT_ALLOWED", `host "${url.hostname}" is not allowed.`);
  }
  if (url.port !== TEST_DATABASE_TARGET.port) {
    throw new TestDatabaseGuardError(
      "PORT_NOT_ALLOWED",
      `port "${url.port || "(omitted)"}" is not allowed; it must be explicitly ${TEST_DATABASE_TARGET.port}.`,
    );
  }
  if (url.pathname !== `/${TEST_DATABASE_TARGET.database}`) {
    throw new TestDatabaseGuardError("DATABASE_NOT_ALLOWED", `database "${url.pathname.slice(1)}" is not allowed.`);
  }

  // DB名と同じく、パーセントエンコードした表記も認めず、そのままの文字列で比べる
  const user = url.username;
  if (user !== expectedUser) {
    throw new TestDatabaseGuardError("USER_NOT_ALLOWED", `user "${user}" is not allowed.`);
  }
  if (url.password === "") {
    throw new TestDatabaseGuardError("PASSWORD_MISSING", "password is empty.");
  }
  // ?host= などで接続先を上書きされるのを防ぐ。フラグメントも同様に拒否する
  if (url.search !== "" || url.hash !== "" || databaseUrl.includes("?") || databaseUrl.includes("#")) {
    throw new TestDatabaseGuardError("QUERY_NOT_ALLOWED", "query parameters and fragments are not allowed.");
  }

  if (developmentDatabaseUrl !== undefined && developmentDatabaseUrl !== "") {
    if (databaseUrl === developmentDatabaseUrl) {
      throw new TestDatabaseGuardError("MATCHES_DEVELOPMENT_DATABASE", "DATABASE_URL equals the development database URL.");
    }
    const development = parsePostgresUrl(developmentDatabaseUrl);
    if (!development) {
      throw new TestDatabaseGuardError("DEVELOPMENT_URL_INVALID", "the development database URL could not be parsed.");
    }
    if (pointsToSameDatabase(url, development.url)) {
      throw new TestDatabaseGuardError(
        "MATCHES_DEVELOPMENT_DATABASE",
        "DATABASE_URL points to the same host, port and database as the development database.",
      );
    }
  }

  const keys = Object.keys(env).filter((key) => env[key] !== undefined);
  const pgKeys = keys.filter((key) => PG_ENV_PATTERN.test(key));
  if (pgKeys.length > 0) {
    throw new TestDatabaseGuardError("PG_ENV_PRESENT", `connection-related variables are set: ${pgKeys.sort().join(", ")}.`);
  }
  const dotenvKeys = keys.filter((key) => DOTENV_ENV_PATTERN.test(key));
  if (dotenvKeys.length > 0) {
    throw new TestDatabaseGuardError("DOTENV_ENV_PRESENT", `dotenv control variables are set: ${dotenvKeys.sort().join(", ")}.`);
  }

  return { host: url.hostname, port: url.port, database: TEST_DATABASE_TARGET.database, user };
}

/** `.env.test` の、katana_test_user のパスワード（DATABASE_URL のパスワードと同じ値） */
export const TEST_DB_APP_PASSWORD_KEY = "KATANA_TEST_DB_PASSWORD";
/** `.env.test` の、初期化だけに使う管理用ユーザー（postgres）のパスワード */
export const TEST_DB_ADMIN_PASSWORD_KEY = "KATANA_TEST_DB_ADMIN_PASSWORD";

/**
 * パスワードに使える文字。URLの中でパーセントエンコードが要らない文字だけにして、
 * DATABASE_URL に書かれたままの文字列（エンコードを解かない）と KATANA_TEST_DB_PASSWORD を、そのまま比べられるようにする。
 */
const PASSWORD_CHARSET = /^[A-Za-z0-9_-]+$/;
/** .env.test.example の見本の値（CHANGE_ME_…）など */
const PASSWORD_PLACEHOLDER = /change[_-]?me/i;

export type TestDatabaseCredentialsErrorCode =
  | "URL_INVALID"
  | "APP_PASSWORD_MISSING"
  | "ADMIN_PASSWORD_MISSING"
  | "PASSWORD_PLACEHOLDER"
  | "PASSWORD_CHARSET"
  | "URL_PASSWORD_MISMATCH"
  | "ADMIN_PASSWORD_SAME_AS_APP";

export class TestDatabaseCredentialsError extends Error {
  readonly code: TestDatabaseCredentialsErrorCode;
  /** コードを除いた説明（パスワード・接続URLを含まない）。呼び出し側が自分のエラーに包むときに使う */
  readonly detail: string;

  constructor(code: TestDatabaseCredentialsErrorCode, detail: string) {
    super(`[testDatabaseGuard] ${code}: ${detail}`);
    this.name = "TestDatabaseCredentialsError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * `.env.test`（dotenv.parse した結果）のパスワードを検証する（R14）。DBには接続しない。
 * assertTestDatabaseTarget() で DATABASE_URL を検証した後に呼ぶ（URLの形式・空のパスワードは、そちらで拒否される）。
 *
 * - KATANA_TEST_DB_PASSWORD・KATANA_TEST_DB_ADMIN_PASSWORD が空でないこと
 * - URLのパスワードを含む3つの値が、見本の値（CHANGE_ME など。大文字・小文字は区別しない）でないこと
 * - 3つの値が、使える文字（`[A-Za-z0-9_-]`）だけでできていること
 * - URLに書かれたままのパスワードが KATANA_TEST_DB_PASSWORD と一致し、管理用のパスワードはそれと違うこと
 *
 * テストDBの経路（Dockerのラッパー・統合テストのrunner・migration用スクリプト・Prisma CLIのテストDBモード）からだけ呼ぶ。
 * 失敗したときのメッセージには、パスワード・接続URLを含めない。成功したら、検証済みの2つのパスワードを返す。
 */
export function assertTestDatabaseCredentials(testEnv: Readonly<Record<string, string | undefined>>): {
  appPassword: string;
  adminPassword: string;
} {
  const parsed = testEnv.DATABASE_URL === undefined ? null : parsePostgresUrl(testEnv.DATABASE_URL);
  if (!parsed) {
    throw new TestDatabaseCredentialsError("URL_INVALID", "DATABASE_URL could not be parsed as a URL.");
  }
  const appPassword = testEnv[TEST_DB_APP_PASSWORD_KEY];
  const adminPassword = testEnv[TEST_DB_ADMIN_PASSWORD_KEY];
  if (appPassword === undefined || appPassword === "") {
    throw new TestDatabaseCredentialsError("APP_PASSWORD_MISSING", `${TEST_DB_APP_PASSWORD_KEY} is not set.`);
  }
  if (adminPassword === undefined || adminPassword === "") {
    throw new TestDatabaseCredentialsError("ADMIN_PASSWORD_MISSING", `${TEST_DB_ADMIN_PASSWORD_KEY} is not set.`);
  }
  // URL の password は、書かれたままの（パーセントエンコードを解かない）文字列。使える文字はエンコードが要らないものだけなので、
  // `%` を含む書き方は PASSWORD_CHARSET で拒否され、エンコードの有無で値が食い違うことはない
  const urlPassword = parsed.url.password;
  const passwords = [urlPassword, appPassword, adminPassword];
  if (passwords.some((value) => PASSWORD_PLACEHOLDER.test(value))) {
    throw new TestDatabaseCredentialsError("PASSWORD_PLACEHOLDER", "a password still has the placeholder value from .env.test.example.");
  }
  if (passwords.some((value) => !PASSWORD_CHARSET.test(value))) {
    throw new TestDatabaseCredentialsError("PASSWORD_CHARSET", "passwords may only contain A-Z, a-z, 0-9, '_' and '-'.");
  }
  if (urlPassword !== appPassword) {
    throw new TestDatabaseCredentialsError("URL_PASSWORD_MISMATCH", `the DATABASE_URL password does not match ${TEST_DB_APP_PASSWORD_KEY}.`);
  }
  if (adminPassword === appPassword) {
    throw new TestDatabaseCredentialsError("ADMIN_PASSWORD_SAME_AS_APP", `${TEST_DB_ADMIN_PASSWORD_KEY} must differ from ${TEST_DB_APP_PASSWORD_KEY}.`);
  }
  return { appPassword, adminPassword };
}

/** runner（scripts/test-integration.mts）が子プロセスに設定する、統合テストの実行モードと runner の目印 */
export const INTEGRATION_TEST_MODE_KEY = "KATANA_DB_TEST_MODE";
export const INTEGRATION_TEST_MODE = "integration";
export const INTEGRATION_RUNNER_KEY = "KATANA_TEST_RUNNER";
export const INTEGRATION_RUNNER = "script";
/** 統合テストのプロセスに設定されていてはいけない環境変数（PG*・DOTENV_* は assertTestDatabaseTarget が別に拒否する） */
export const INTEGRATION_FORBIDDEN_ENV_KEYS: readonly string[] = ["NODE_OPTIONS"];

export type IntegrationRuntimeErrorCode =
  | "TEST_MODE_MISSING"
  | "RUNNER_MARKER_MISSING"
  | "FORBIDDEN_ENV_PRESENT"
  | "TEST_ENV_MISSING"
  | "TEST_ENV_URL_MISSING"
  | "DATABASE_URL_MISMATCH";

export class IntegrationRuntimeError extends Error {
  readonly code: IntegrationRuntimeErrorCode;
  /** コードを除いた説明（パスワード・接続URL・環境変数の値を含まない） */
  readonly detail: string;

  constructor(code: IntegrationRuntimeErrorCode, detail: string) {
    super(`[testDatabaseGuard] ${code}: ${detail}`);
    this.name = "IntegrationRuntimeError";
    this.code = code;
    this.detail = detail;
  }
}

export type IntegrationRuntimeInput = {
  /** 検査するプロセスの環境変数（globalSetup・lib/prisma.ts では process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** `.env.test` を dotenv.parse した結果。ファイルがなければ undefined（読み込みは呼び出し側が行う） */
  testEnv: Readonly<Record<string, string | undefined>> | undefined;
  /** `.env` の DATABASE_URL（開発用DBとの比較だけに使う）。`.env` がなければ undefined */
  developmentDatabaseUrl: string | undefined;
};

/**
 * 統合テストのプロセス（globalSetup・lib/prisma.ts の統合テストモード）で、DBに接続する前に呼ぶ検証（R14-1）。DBには接続しない。
 *
 * runner は同じ検証（接続先・`.env.test` のパスワード）をしてから子プロセスを起動するが、目印の環境変数は誰でも設定できる。
 * そのため、runner を通さずに起動された場合にも同じ条件を満たすことを、ここでもう一度確かめる。順序（最初の失敗で止まる）:
 *
 * 1. 実行モード（KATANA_DB_TEST_MODE=integration）と runner の目印（KATANA_TEST_RUNNER=script）
 * 2. 禁止する環境変数（NODE_OPTIONS）がないこと
 * 3. `.env.test` が存在すること
 * 4. プロセスの DATABASE_URL がテストDBを指すこと（assertTestDatabaseTarget。PG*・DOTENV_*・開発用DBとの比較を含む）
 * 5. プロセスの DATABASE_URL が `.env.test` の DATABASE_URL と完全に一致すること（親から渡された別の値を使わない）
 * 6. `.env.test` のパスワード（assertTestDatabaseCredentials。見本の値・文字種・URLとの一致・管理用との共用）
 *
 * 失敗したときは IntegrationRuntimeError・TestDatabaseGuardError・TestDatabaseCredentialsError を投げる。
 * どのメッセージにも、パスワード・接続URL・環境変数の値を含めない。成功したら、表示してよい接続先の情報を返す。
 */
export function assertIntegrationRuntime(input: IntegrationRuntimeInput): TestDatabaseTarget {
  const { env, testEnv, developmentDatabaseUrl } = input;

  if (env[INTEGRATION_TEST_MODE_KEY] !== INTEGRATION_TEST_MODE) {
    throw new IntegrationRuntimeError("TEST_MODE_MISSING", `${INTEGRATION_TEST_MODE_KEY} is not "${INTEGRATION_TEST_MODE}".`);
  }
  if (env[INTEGRATION_RUNNER_KEY] !== INTEGRATION_RUNNER) {
    throw new IntegrationRuntimeError("RUNNER_MARKER_MISSING", `${INTEGRATION_RUNNER_KEY} is not "${INTEGRATION_RUNNER}".`);
  }
  const forbidden = INTEGRATION_FORBIDDEN_ENV_KEYS.filter((key) => env[key] !== undefined && env[key] !== "");
  if (forbidden.length > 0) {
    // 変数の名前だけを示す（値は表示しない）
    throw new IntegrationRuntimeError("FORBIDDEN_ENV_PRESENT", `forbidden variables are set: ${forbidden.join(", ")}.`);
  }
  if (testEnv === undefined) {
    throw new IntegrationRuntimeError("TEST_ENV_MISSING", ".env.test was not found.");
  }

  const target = assertTestDatabaseTarget({ databaseUrl: env.DATABASE_URL, env, developmentDatabaseUrl });

  const expectedUrl = testEnv.DATABASE_URL;
  if (expectedUrl === undefined || expectedUrl === "") {
    throw new IntegrationRuntimeError("TEST_ENV_URL_MISSING", ".env.test does not define DATABASE_URL.");
  }
  if (env.DATABASE_URL !== expectedUrl) {
    throw new IntegrationRuntimeError("DATABASE_URL_MISMATCH", "DATABASE_URL does not match the DATABASE_URL in .env.test.");
  }

  assertTestDatabaseCredentials(testEnv);
  return target;
}

/** アプリ（Next の開発サーバーなど）の接続先を切り替える環境変数（prisma.config.ts の Prisma CLI のガードと同じ名前・同じ値） */
export const APP_DB_TARGET_KEY = "KATANA_DB_TARGET";
export const APP_DB_TARGET_TEST = "test";

export type AppDatabaseTargetErrorCode = "TARGET_INVALID" | "TEST_ENV_MISSING" | "TEST_ENV_URL_MISSING" | "DATABASE_URL_MISMATCH";

export class AppDatabaseTargetError extends Error {
  readonly code: AppDatabaseTargetErrorCode;
  /** コードを除いた説明（パスワード・接続URL・環境変数の値を含まない） */
  readonly detail: string;

  constructor(code: AppDatabaseTargetErrorCode, detail: string) {
    super(`[testDatabaseGuard] ${code}: ${detail}`);
    this.name = "AppDatabaseTargetError";
    this.code = code;
    this.detail = detail;
  }
}

export type AppDatabaseTargetInput = {
  /** 検査するプロセスの環境変数（lib/prisma.ts では process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** `.env.test` を dotenv.parse した結果。ファイルがなければ undefined（読み込みは呼び出し側が行う） */
  testEnv: Readonly<Record<string, string | undefined>> | undefined;
  /** `.env` の DATABASE_URL（開発用DBとの比較だけに使う）。`.env` がなければ undefined */
  developmentDatabaseUrl: string | undefined;
};

export type AppDatabaseTarget = { mode: "default" } | { mode: "test"; target: TestDatabaseTarget };

/**
 * アプリ（Vitest の外。Next の開発サーバーなど）の接続先の検証（P9。E2E の前提）。DBには接続しない。
 *
 * - KATANA_DB_TARGET が未設定：何も検査せず `{ mode: "default" }` を返す（開発・本番の従来の動作を変えない）。
 * - KATANA_DB_TARGET=test：E2E 用の開発サーバー。次をすべて満たさなければ throw する（最初の失敗で止まる）:
 *   1. `.env.test` が存在し、DATABASE_URL を定義していること
 *   2. プロセスの DATABASE_URL がテストDBを指すこと（assertTestDatabaseTarget。PG*・DOTENV_*・開発用DBとの比較を含む）
 *   3. プロセスの DATABASE_URL が `.env.test` の DATABASE_URL と完全に一致すること（Next が読む `.env` の値を使わない）
 *   4. `.env.test` のパスワード（assertTestDatabaseCredentials）
 * - それ以外の値（空文字列・大文字の違いを含む）：TARGET_INVALID（Prisma CLI のガードと同じ。取り違えても接続しない）。
 *
 * NODE_OPTIONS は、ここでは検査しない（Next の開発サーバーが子プロセスに設定することがあり、アプリの中では起動した側と区別できないため）。
 * 親のプロセスの NODE_OPTIONS は、開発サーバーを起動するスクリプトの側で拒否する。
 * 失敗したときのメッセージには、パスワード・接続URL・環境変数の値を含めない。
 */
export function assertAppDatabaseTarget(input: AppDatabaseTargetInput): AppDatabaseTarget {
  const { env, testEnv, developmentDatabaseUrl } = input;
  const value = env[APP_DB_TARGET_KEY];
  if (value === undefined) return { mode: "default" };
  if (value !== APP_DB_TARGET_TEST) {
    throw new AppDatabaseTargetError("TARGET_INVALID", `${APP_DB_TARGET_KEY} must be unset or exactly "${APP_DB_TARGET_TEST}".`);
  }

  if (testEnv === undefined) {
    throw new AppDatabaseTargetError("TEST_ENV_MISSING", ".env.test was not found.");
  }
  const expectedUrl = testEnv.DATABASE_URL;
  if (expectedUrl === undefined || expectedUrl === "") {
    throw new AppDatabaseTargetError("TEST_ENV_URL_MISSING", ".env.test does not define DATABASE_URL.");
  }

  const target = assertTestDatabaseTarget({ databaseUrl: env.DATABASE_URL, env, developmentDatabaseUrl });
  if (env.DATABASE_URL !== expectedUrl) {
    throw new AppDatabaseTargetError("DATABASE_URL_MISMATCH", "DATABASE_URL does not match the DATABASE_URL in .env.test.");
  }
  assertTestDatabaseCredentials(testEnv);
  return { mode: "test", target };
}

/** `.env.test.readonly` の、katana_test_ro の接続URL（Step 3-12B-5E-3。`.env.test` には置かない） */
export const TEST_DB_RO_URL_KEY = "KATANA_TEST_RO_DATABASE_URL";
/** `.env.test.readonly` の、katana_test_ro のパスワード（KATANA_TEST_RO_DATABASE_URL のパスワードと同じ値） */
export const TEST_DB_RO_PASSWORD_KEY = "KATANA_TEST_DB_RO_PASSWORD";
/** katana_test_ro のパスワードの最短の長さ（SCRAM の検証子は辞書攻撃の材料になり得るので、長いランダムな値を求める） */
export const TEST_DB_RO_PASSWORD_MIN_LENGTH = 32;
const READ_ONLY_ENV_KEYS = [TEST_DB_RO_URL_KEY, TEST_DB_RO_PASSWORD_KEY];

export type ReadOnlyTestDatabaseCredentialsErrorCode =
  | "RO_ENV_UNEXPECTED_KEY"
  | "RO_URL_INVALID"
  | "RO_PASSWORD_MISSING"
  | "RO_PASSWORD_PLACEHOLDER"
  | "RO_PASSWORD_CHARSET"
  | "RO_PASSWORD_TOO_SHORT"
  | "RO_URL_PASSWORD_MISMATCH"
  | "RO_PASSWORD_REUSED"
  | "RO_URL_SAME_AS_APP";

export class ReadOnlyTestDatabaseCredentialsError extends Error {
  readonly code: ReadOnlyTestDatabaseCredentialsErrorCode;
  /** コードを除いた説明（パスワード・接続URLを含まない） */
  readonly detail: string;

  constructor(code: ReadOnlyTestDatabaseCredentialsErrorCode, detail: string) {
    super(`[testDatabaseGuard] ${code}: ${detail}`);
    this.name = "ReadOnlyTestDatabaseCredentialsError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * `.env.test.readonly`（dotenv.parse した結果）の、katana_test_ro の認証情報を検証する。DBには接続しない。
 * 接続先（ホスト・ポート・DB・ユーザー katana_test_ro・クエリなし・開発用DBでない）は assertReadOnlyTestDatabaseTarget で先に検証する。
 * `.env.test` は assertTestDatabaseCredentials で先に検証し、その結果（アプリ用・管理用のパスワード）を渡す。
 *
 * - キーは KATANA_TEST_RO_DATABASE_URL・KATANA_TEST_DB_RO_PASSWORD の2つだけ
 * - パスワードは空でない・見本の値でない・使える文字（`[A-Za-z0-9_-]`。SASLprep で変化しない）だけ・32文字以上
 * - URLに書かれたままのパスワードと KATANA_TEST_DB_RO_PASSWORD が一致する
 * - アプリ用・管理用のパスワードと違う。URL がアプリ用の DATABASE_URL と違う
 * 失敗したときのメッセージには、パスワード・接続URLを含めない。成功したら、検証済みの URL とパスワードを返す。
 */
export function assertReadOnlyTestDatabaseCredentials(
  readOnlyEnv: Readonly<Record<string, string | undefined>>,
  app: { databaseUrl: string; appPassword: string; adminPassword: string },
): { databaseUrl: string; password: string } {
  const unexpected = Object.keys(readOnlyEnv).filter((key) => !READ_ONLY_ENV_KEYS.includes(key));
  if (unexpected.length > 0) {
    // キーの名前は秘密情報ではないので表示する
    throw new ReadOnlyTestDatabaseCredentialsError("RO_ENV_UNEXPECTED_KEY", `unexpected keys: ${unexpected.sort().join(", ")}.`);
  }
  const databaseUrl = readOnlyEnv[TEST_DB_RO_URL_KEY];
  const parsed = databaseUrl === undefined ? null : parsePostgresUrl(databaseUrl);
  if (!parsed || databaseUrl === undefined) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_URL_INVALID", `${TEST_DB_RO_URL_KEY} could not be parsed as a URL.`);
  }
  const password = readOnlyEnv[TEST_DB_RO_PASSWORD_KEY];
  if (password === undefined || password === "") {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_PASSWORD_MISSING", `${TEST_DB_RO_PASSWORD_KEY} is not set.`);
  }
  const urlPassword = parsed.url.password;
  if ([urlPassword, password].some((value) => PASSWORD_PLACEHOLDER.test(value))) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_PASSWORD_PLACEHOLDER", "the read-only password still has a placeholder value.");
  }
  if ([urlPassword, password].some((value) => !PASSWORD_CHARSET.test(value))) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_PASSWORD_CHARSET", "the read-only password may only contain A-Z, a-z, 0-9, '_' and '-'.");
  }
  if (password.length < TEST_DB_RO_PASSWORD_MIN_LENGTH) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_PASSWORD_TOO_SHORT", `the read-only password must be at least ${TEST_DB_RO_PASSWORD_MIN_LENGTH} characters.`);
  }
  if (urlPassword !== password) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_URL_PASSWORD_MISMATCH", `the ${TEST_DB_RO_URL_KEY} password does not match ${TEST_DB_RO_PASSWORD_KEY}.`);
  }
  if (password === app.appPassword || password === app.adminPassword) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_PASSWORD_REUSED", "the read-only password must differ from the application and admin passwords.");
  }
  if (databaseUrl === app.databaseUrl) {
    throw new ReadOnlyTestDatabaseCredentialsError("RO_URL_SAME_AS_APP", `${TEST_DB_RO_URL_KEY} must differ from DATABASE_URL.`);
  }
  return { databaseUrl, password };
}
