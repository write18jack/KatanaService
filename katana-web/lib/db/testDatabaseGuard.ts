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
  if (user !== TEST_DATABASE_TARGET.user) {
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
