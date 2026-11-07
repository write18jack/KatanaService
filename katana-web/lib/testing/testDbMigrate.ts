import { readFileSync } from "node:fs";
import path from "node:path";
import { DB_TARGET_ENV, DB_TARGET_TEST } from "../db/prismaCliGuard.ts";
import {
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import {
  applicationTablesFromSchema,
  EXPECTED_DATABASE,
  EXPECTED_USER,
  IntegrationDatabaseCheckError,
  type IntegrationDbClient,
  listMigrationNames,
  TEST_DATABASE_MARKER,
} from "./integrationDatabaseCheck.ts";
import { DEVELOPMENT_ENV_FILE, inheritAllowedEnv, TEST_ENV_FILE } from "./integrationEnv.ts";
import {
  addressMatchesContainer,
  dockerIdentityChanges,
  serverDockerMismatches,
  serverIdentityChanges,
  serverIdentityMismatches,
  type TestDatabaseServerIdentity,
  type TestDbDockerIdentity,
} from "./testDbIdentity.ts";
import {
  classifyTestDatabase,
  enumNamesFromSchema,
  inspectTestDatabase,
  missingMigrationPrivileges,
  type TestDatabaseInspection,
  type TestDatabasePrivileges,
  type TestDatabaseState,
} from "./testDbState.ts";

/**
 * テストDB専用の migration（scripts/testdb-migrate.mts）の本体。
 *
 * 外部とのやりとり（env ファイルの読み込み、ファイルの存在確認、DBの状態の判定、子プロセスの起動、表示）は
 * すべて引数で受け取る。そのため、単体テストでは Prisma CLI を起動せず、DBにも接続せずに検証できる。
 *
 * 実行順序（途中で失敗したら、その時点で止める。別の接続先は試さない）:
 * 1. 引数の検証、Node の起動オプション（execArgv・NODE_OPTIONS）の確認  2. `.env.test` の読み込み
 * 3. `.env` の開発用DBの接続先の取得  4. テストDBのURLの検証（assertTestDatabaseTarget）
 * 5. パスワードの検証（assertTestDatabaseCredentials。R14）
 * 6. 親のプロセスの PG*・DOTENV_* の拒否（状態の判定の接続は、このプロセスの中で pg が行い、pg は PG* を読むため）
 * 7. 子プロセスの環境変数の生成（作った後にもう一度検証）  8. 実行する Prisma CLI のコマンドの確認
 *    （確認モードはここで表示して終了する。DBには接続しない）
 * 実DBへの接続の許可（liveDatabase）：無効なら、ここで TESTDB_MIGRATION_LIVE_DISABLED で止まる。
 * 9〜11. 読み取り専用の接続・本人確認・状態 A・B・C の判定と、migration に必要な権限の読み取り（inspectDatabase。接続は判定ごとに1回で、終わったら閉じる）
 * 12. A のときだけ、権限がすべてそろっていることを確かめてから、固定のコマンドで Prisma CLI（`migrate deploy`）を起動する
 *     （不足なら MIGRATION_PRIVILEGES_INSUFFICIENT で止まる）。B は理由を表示して止まり、C は起動せずに成功とする
 * 13. migration の後に、別の接続でもう一度、本人確認と状態の判定を行う  14. C であることを確かめて終了する
 *
 * 接続先の照合（Step 3-11E。TOCTOU の対策。migration 用の許可が有効なときだけ動く。スクリプトでは無効のまま）:
 * Docker の識別情報 D1 → DB の本人確認・権限・状態・識別情報 F1（D1 と照合）→ Prisma CLI の直前に D2（D1 と一致）→ migrate deploy
 * → DB の再確認 F2（F1 と一致、状態 C）→ D3（D1 と一致）。どれかが合わなければ止まる（自動の修復・再接続はしない）。
 * D1・F1・D2 の不一致は Prisma CLI の起動の前に止める（防止）。F2・D3 の不一致は、Prisma CLI の実行の後に異常として検出するだけ（防止ではない）。
 * これは読んだ時点の照合で、Prisma CLI の新しい接続が同じDBに届くことを完全には保証しない（入れ替わりは事後に検出する）。
 *
 * 読み取り専用の検証モード（`--verify`。Step 3-11B）は、1〜7を共有した後、通常実行モードとは別の経路に分かれる:
 * 読み取り専用の接続の許可（readOnlyDatabase。migration 用の liveDatabase とは別）を確かめ、本人確認と状態の判定を1回だけ行って、
 * 結果を表示して終わる。A・C は成功、B は失敗。**どの状態でも Prisma CLI を起動せず（spawn を呼ばない）、liveDatabase も使わない。**
 * 判定の SQL は `BEGIN READ ONLY`・search_path の固定（トランザクションの中だけ）・SHOW・SELECT・ROLLBACK だけ（lib/testing/testDbState.ts）。
 *
 * どの状態でも、reset・DROP・TRUNCATE・DELETE・自動復旧・migration の自動継続は行わない。
 * 判定（9〜11・13）そのものの失敗は、A・B・C のどれとも扱わず、Prisma CLI を起動せずに止まる。
 * C は、列・インデックス・制約の定義の一致までは保証しない（schemaDiff は not-verified。Step 3-12 の migrate diff）。
 *
 * Prisma CLI のコマンドは `migrate deploy` に固定し、外部から引数を渡せない。`migrate deploy` は未適用の migration を
 * 適用するだけで、DBの作り直し・Prisma Client の生成・seed は行わない。
 * 表示・例外のメッセージには、接続URL・パスワードを含めない。
 */

export const PRISMA_CLI_ENTRY = path.join("node_modules", "prisma", "build", "index.js");
export const PRISMA_CONFIG_FILE = "prisma.config.ts";
/** 子プロセスに渡す Prisma CLI のサブコマンド（固定） */
export const PRISMA_MIGRATE_COMMAND = ["migrate", "deploy"] as const;
/** 起動前に存在を確かめるファイル・ディレクトリ */
const REQUIRED_PATHS = [PRISMA_CLI_ENTRY, PRISMA_CONFIG_FILE, path.join("prisma", "schema.prisma"), path.join("prisma", "migrations")];
/** 表示するときに値を伏せる環境変数 */
const HIDDEN_VALUE_KEYS = new Set(["DATABASE_URL"]);
/** 落としたことを名前で表示する環境変数（接続先・読み込みに関わるもの） */
const NOTABLE_DROPPED_KEY = /^(PG|DOTENV_|NODE_|PRISMA_|KATANA_|DATABASE_URL$)/;

export type TestDbMigrateErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "REQUIRED_FILE_MISSING"
  | "TESTDB_MIGRATION_LIVE_DISABLED"
  | "TESTDB_VERIFY_LIVE_DISABLED"
  | "VERIFY_CHECK_FAILED"
  | "MIGRATION_PRIVILEGES_INSUFFICIENT"
  | "SERVER_IDENTITY_MISMATCH"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "POST_MIGRATION_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "DATABASE_STATE_INCONSISTENT"
  | "MIGRATION_FAILED"
  | "POST_MIGRATION_CHECK_FAILED"
  | "POST_MIGRATION_STATE_MISMATCH";

export class TestDbMigrateError extends Error {
  readonly code: TestDbMigrateErrorCode;

  constructor(code: TestDbMigrateErrorCode, detail: string) {
    super(`[testdb-migrate] ${code}: ${detail}`);
    this.name = "TestDbMigrateError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type TestDbMigrateMode = "run" | "check" | "verify";

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  stdio: "inherit";
};

/** 検証済みの接続URLで、DBの状態 A・B・C を読み取り専用で判定する（判定ごとに接続し、終わったら閉じる） */
export type ClassifyDatabase = (input: { databaseUrl: string; developmentDatabaseUrl: string | undefined }) => Promise<TestDatabaseState>;
/** 状態の判定と同じ読み取り専用のトランザクションで、migration に必要な権限も読む（状態の判定は ClassifyDatabase と同じ） */
export type InspectDatabase = (input: Parameters<ClassifyDatabase>[0]) => Promise<TestDatabaseInspection>;

/**
 * 実DBへの接続の許可。scripts/testdb-migrate.mts は LIVE_DATABASE_DISABLED を固定で渡す（環境変数・引数では変えられない）。
 * 有効にするのは、承認を得た後続の工程で、スクリプトのコードを変えたときだけ。単体テストは、偽の判定関数で有効にする。
 */
/** テストDBのコンテナの識別情報を、読み取り専用の docker コマンドで読む（scripts/testdb.mts の readTestDbDockerIdentity） */
export type ReadDockerIdentity = () => Promise<TestDbDockerIdentity>;
export type LiveDatabaseAccess =
  | { readonly mode: "disabled" }
  | { readonly mode: "enabled"; readonly inspectDatabase: InspectDatabase; readonly readDockerIdentity: ReadDockerIdentity };
export const LIVE_DATABASE_DISABLED: LiveDatabaseAccess = Object.freeze({ mode: "disabled" });

/**
 * 読み取り専用の検証モード（`--verify`）の、実DBへの接続の許可。migration 用の LiveDatabaseAccess とは別の型・別の値で、共有しない。
 * scripts/testdb-migrate.mts は READ_ONLY_DATABASE_DISABLED を固定で渡す（環境変数・引数では変えられない）。
 * 有効にするのは、個別の承認を得た後続の工程で、スクリプトのコードを変えたときだけ。単体テストは、偽の判定関数で有効にする。
 */
export type ReadOnlyDatabaseAccess =
  | { readonly mode: "disabled" }
  | { readonly mode: "enabled-read-only"; readonly inspectDatabase: InspectDatabase };
export const READ_ONLY_DATABASE_DISABLED: ReadOnlyDatabaseAccess = Object.freeze({ mode: "disabled" });

export type TestDbMigrateDeps = {
  /** katana-web/ の絶対パス（子プロセスの作業ディレクトリ） */
  root: string;
  /** スクリプトに渡された引数（process.argv.slice(2)） */
  argv: readonly string[];
  /** process.execArgv */
  execArgv: readonly string[];
  /** 子プロセスで使う Node の実行ファイル（process.execPath） */
  execPath: string;
  parentEnv: EnvSource;
  /** env ファイルを dotenv.parse で読む。ファイルがなければ undefined */
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** 実DBへの接続の許可と、状態の判定。通常実行モードで、確認モードの終了点より後にだけ使う */
  liveDatabase: LiveDatabaseAccess;
  /** 読み取り専用の検証モード（--verify）だけで使う、実DBへの接続の許可と状態の判定。liveDatabase とは共有しない */
  readOnlyDatabase: ReadOnlyDatabaseAccess;
  /** 子プロセスを起動し、終了コードを返す */
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => Promise<number>;
  log: (text: string) => void;
};

export function parseTestDbMigrateArgs(args: readonly string[]): TestDbMigrateMode {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "--check") return "check";
  if (args.length === 1 && args[0] === "--verify") return "verify";
  throw new TestDbMigrateError("ARGUMENTS_INVALID", "the only accepted arguments are --check or --verify (one at a time).");
}

/** 検証関数を実行し、失敗したらエラーコードだけを含むエラーに置き換える（拒否された値を表示しない） */
function verifyTarget(databaseUrl: string | undefined, env: EnvSource, developmentEnv: EnvSource | undefined): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbMigrateError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    throw error;
  }
}

/**
 * 子プロセスの環境変数を作る。親からは許可リストのものだけを引き継ぎ、DATABASE_URL は検証済みの値だけを設定する。
 * PG*・DOTENV_*・NODE_OPTIONS・親の DATABASE_URL・PRISMA_* などは引き継がない。
 */
export function buildTestDbMigrateEnv(parentEnv: EnvSource, verifiedDatabaseUrl: string): { childEnv: Record<string, string>; droppedKeys: string[] } {
  const { inherited, droppedKeys } = inheritAllowedEnv(parentEnv);
  return { childEnv: { ...inherited, DATABASE_URL: verifiedDatabaseUrl, [DB_TARGET_ENV]: DB_TARGET_TEST }, droppedKeys };
}

/**
 * 状態の判定の関数を作る。期待値（テーブル・enum・migration の名前）は、作るときに schema.prisma と prisma/migrations から読む。
 * connect には lib/testing/testDbConnection.ts の connectTestDatabase を渡す（pg を読み込むのは、そのファイルだけ）。
 * まだどこからも呼ばない（scripts/testdb-migrate.mts への組み込みは、実DBへの接続の承認の後）。
 */
export function createTestDatabaseClassifier(input: {
  root: string;
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
}): ClassifyDatabase {
  const expected = readExpectation(input.root);
  return ({ databaseUrl, developmentDatabaseUrl }) => classifyTestDatabase({ databaseUrl, developmentDatabaseUrl, expected, connect: input.connect });
}

/** createTestDatabaseClassifier と同じ期待値で、状態の判定と権限の読み取りを行う関数を作る（--verify・migration の前後で使う） */
export function createTestDatabaseInspector(input: {
  root: string;
  connect: (databaseUrl: string) => Promise<IntegrationDbClient>;
}): InspectDatabase {
  const expected = readExpectation(input.root);
  return ({ databaseUrl, developmentDatabaseUrl }) => inspectTestDatabase({ databaseUrl, developmentDatabaseUrl, expected, connect: input.connect });
}

function readExpectation(root: string) {
  const schemaSource = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  return {
    tables: applicationTablesFromSchema(schemaSource),
    enums: enumNamesFromSchema(schemaSource),
    migrations: listMigrationNames(path.join(root, "prisma", "migrations")),
  };
}

/** 接続先の識別情報の表示（URL・パスワードは含まない） */
function formatServerIdentity(server: TestDatabaseServerIdentity): string[] {
  return [
    `inet_server_addr: ${server.serverAddress}`,
    `inet_server_port: ${server.serverPort} (inside the container; the host port 5434 cannot be seen from the database)`,
    `pg_postmaster_start_time: ${server.postmasterStartTime}`,
  ];
}

/** Docker の識別情報を読む。失敗したら、コードだけを含むエラーに置き換える（自動の再試行はしない） */
async function readDockerOrStop(read: ReadDockerIdentity, when: string): Promise<TestDbDockerIdentity> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const detail = typeof code === "string" && /^[A-Z][A-Z_]*$/.test(code) ? code : "unknown";
    throw new TestDbMigrateError("DOCKER_IDENTITY_FAILED", `the docker identity check ${when} failed (${detail}); the Prisma CLI was not started for this check.`);
  }
}

/** Docker の識別情報が、最初に読んだ値から変わっていないこと */
function assertSameDocker(first: TestDbDockerIdentity, now: TestDbDockerIdentity, code: "DOCKER_IDENTITY_MISMATCH" | "POST_MIGRATION_IDENTITY_MISMATCH"): void {
  const changes = dockerIdentityChanges(first, now);
  if (changes.length > 0) {
    throw new TestDbMigrateError(code, `the test database container changed (${changes.join(", ")}). Nothing was reset or repaired.`);
  }
}

/** 権限の表示（値は真偽値だけ） */
function formatPrivileges(privileges: TestDatabasePrivileges): string[] {
  return [
    `public USAGE: ${privileges.publicUsage}`,
    `public CREATE: ${privileges.publicCreate}`,
    `database owner is ${EXPECTED_USER}: ${privileges.databaseOwner}`,
    `database CREATE: ${privileges.databaseCreate}`,
  ];
}

const CHECK_LABELS = {
  STATE_CHECK_FAILED: "pre-migration",
  POST_MIGRATION_CHECK_FAILED: "post-migration",
  VERIFY_CHECK_FAILED: "read-only verification",
} as const;

/** 判定を実行し、失敗したらコードだけを含むエラーに置き換える（A・B・C のどれとも扱わない） */
async function inspectOrStop(
  inspect: InspectDatabase,
  input: Parameters<ClassifyDatabase>[0],
  code: keyof typeof CHECK_LABELS,
): Promise<TestDatabaseInspection> {
  try {
    return await inspect(input);
  } catch (error) {
    const detail = error instanceof IntegrationDatabaseCheckError ? error.code : "unknown";
    throw new TestDbMigrateError(code, `the ${CHECK_LABELS[code]} database check failed (${detail}); the Prisma CLI was not started for this check.`);
  }
}

/** schema.prisma・prisma/migrations（状態の判定の期待値）。--verify では、Prisma CLI の存在は確かめない */
const VERIFY_REQUIRED_PATHS = [path.join("prisma", "schema.prisma"), path.join("prisma", "migrations")];

/**
 * 読み取り専用の検証モード（--verify）。通常実行モードとは別の経路で、Prisma CLI（spawn）と liveDatabase を一切使わない。
 * 本人確認（DB名・current_user・session_user・DBのコメント）と search_path の固定は、判定の中で行う（失敗したら判定が throw する）。
 */
async function runReadOnlyVerify(input: {
  deps: TestDbMigrateDeps;
  target: TestDatabaseTarget;
  checkInput: Parameters<ClassifyDatabase>[0];
}): Promise<number> {
  const { deps, target, checkInput } = input;
  for (const relative of VERIFY_REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(deps.root, relative))) {
      throw new TestDbMigrateError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
    }
  }

  // 読み取り専用の接続の許可（スクリプトでは常に無効。接続の前に止まる）
  if (deps.readOnlyDatabase.mode !== "enabled-read-only") {
    throw new TestDbMigrateError(
      "TESTDB_VERIFY_LIVE_DISABLED",
      "read-only database verification is disabled in this build; refusing to connect to the test database.",
    );
  }

  const { state, privileges, server } = await inspectOrStop(deps.readOnlyDatabase.inspectDatabase, checkInput, "VERIFY_CHECK_FAILED");
  const missing = missingMigrationPrivileges(privileges);
  const serverMismatches = serverIdentityMismatches(server);
  // 状態と権限は別々に表示する（権限が足りなくても、状態の判定は変えない）
  deps.log(
    [
      `[testdb-migrate] verify mode: read-only check of ${target.host}:${target.port}/${target.database} as ${target.user} (password hidden).`,
      `identity: current_database() = ${EXPECTED_DATABASE}, current_user = session_user = ${EXPECTED_USER}, database comment = "${TEST_DATABASE_MARKER}"; search_path pinned to pg_catalog.`,
      "the Prisma CLI was not started; nothing was migrated, reset or changed (the transaction was rolled back).",
      ...(state.state === "A"
        ? ["database state: A (the database is empty; no migrations applied)"]
        : state.state === "C"
          ? [
              `database state: C (all ${state.migrations.length} expected migrations are applied and the tables are empty; ` +
                "column, index and constraint definitions were not compared: schema diff not verified, Step 3-12)",
            ]
          : ["database state: B (partially applied, failed or unexpected objects)", ...state.reasons.map((r) => `  - ${r}`)]),
      "migration privileges:",
      ...formatPrivileges(privileges).map((line) => `  ${line}`),
      "server identity (a snapshot at this check; it does not pin later connections):",
      ...formatServerIdentity(server).map((line) => `  ${line}`),
    ].join("\n"),
  );
  if (serverMismatches.length > 0) {
    throw new TestDbMigrateError("SERVER_IDENTITY_MISMATCH", `the server identity is unexpected (${serverMismatches.join(", ")}).`);
  }
  if (state.state === "B") {
    throw new TestDbMigrateError("DATABASE_STATE_INCONSISTENT", "the test database is neither empty nor fully migrated. Nothing was reset or repaired.");
  }
  if (missing.length > 0) {
    throw new TestDbMigrateError("MIGRATION_PRIVILEGES_INSUFFICIENT", `${EXPECTED_USER} lacks privileges required for migrations (${missing.join(", ")}). Nothing was granted or changed.`);
  }
  return 0;
}

function formatCheckReport(input: {
  liveDatabase: LiveDatabaseAccess;
  readOnlyDatabase: ReadOnlyDatabaseAccess;
  root: string;
  target: TestDatabaseTarget;
  execPath: string;
  args: readonly string[];
  childEnv: Record<string, string>;
  droppedKeys: string[];
}): string {
  const { liveDatabase, readOnlyDatabase, root, target, execPath, args, childEnv, droppedKeys } = input;
  return [
    "[testdb-migrate] check mode: the Prisma CLI was not started and no database connection was made.",
    "",
    `connection target: verified ${target.host}:${target.port}/${target.database} as ${target.user} (${TEST_ENV_FILE} DATABASE_URL; password hidden)`,
    `working directory: ${root}`,
    `command: ${path.basename(execPath)} ${args.map((arg) => (path.isAbsolute(arg) ? path.relative(root, arg) : arg)).join(" ")} (no shell)`,
    "database checks: identity and state (A: empty / B: inconsistent / C: fully migrated) before the Prisma CLI, and again after it (not run in check mode)",
    `live database access: ${liveDatabase.mode === "enabled" ? "enabled" : "disabled in this build (normal mode stops with TESTDB_MIGRATION_LIVE_DISABLED before connecting)"}`,
    `read-only verification (--verify): ${readOnlyDatabase.mode === "enabled-read-only" ? "enabled" : "disabled in this build (stops with TESTDB_VERIFY_LIVE_DISABLED before connecting)"}`,
    "",
    "child environment:",
    ...Object.keys(childEnv)
      .sort()
      .map((key) => `  ${key}=${HIDDEN_VALUE_KEYS.has(key) ? "(hidden)" : childEnv[key]}`),
    "",
    `dropped from the parent environment: ${droppedKeys.length} variable(s)`,
    ...droppedKeys.filter((key) => NOTABLE_DROPPED_KEY.test(key)).map((key) => `  ${key}`),
  ].join("\n");
}

/** 手順どおりに検証し、通常実行モードでは子プロセスの終了コードを、確認モードでは0を返す */
export async function runTestDbMigrate(deps: TestDbMigrateDeps): Promise<number> {
  const { root } = deps;

  // 1. 引数
  const mode = parseTestDbMigrateArgs(deps.argv);

  // 1. --import・--require などで、スクリプトより先にコードが読み込まれていないこと
  if (deps.execArgv.length > 0) {
    throw new TestDbMigrateError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  }
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbMigrateError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the test database migration.");
  }

  // 2. .env.test（親プロセスの DATABASE_URL は使わない）
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) {
    throw new TestDbMigrateError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found; create it before running the test database migration.`);
  }

  // 3. 開発用DBの接続先（比較にだけ使う）
  const developmentEnv = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE));

  // 4. URLの検証（環境変数の検査は、6・7で行う）と、5. パスワードの検証（R14）
  const databaseUrl = testEnv.DATABASE_URL;
  verifyTarget(databaseUrl, {}, developmentEnv);
  try {
    assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new TestDbMigrateError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const verifiedUrl = databaseUrl as string;

  // 6. 親のプロセスの PG*・DOTENV_*（状態の判定の接続は、このプロセスの pg が行う。確認モードでも同じ判定にする）
  try {
    assertTestDatabaseTarget({ databaseUrl: verifiedUrl, env: deps.parentEnv, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbMigrateError("UNSAFE_PARENT_ENV", `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.`);
    }
    throw error;
  }

  // 7. 子プロセスの環境変数。作った後の最終的な値で、もう一度検証する
  const { childEnv, droppedKeys } = buildTestDbMigrateEnv(deps.parentEnv, verifiedUrl);
  const target = verifyTarget(childEnv.DATABASE_URL, childEnv, developmentEnv);
  const checkInput = { databaseUrl: verifiedUrl, developmentDatabaseUrl: developmentEnv?.DATABASE_URL };

  // 読み取り専用の検証モードは、ここで通常実行モード・確認モードと分かれる（Prisma CLI のコマンドを組み立てない）
  if (mode === "verify") return runReadOnlyVerify({ deps, target, checkInput });

  // 8. コマンド（固定）
  for (const relative of REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(root, relative))) {
      throw new TestDbMigrateError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
    }
  }
  const args = [path.join(root, PRISMA_CLI_ENTRY), ...PRISMA_MIGRATE_COMMAND, "--config", path.join(root, PRISMA_CONFIG_FILE)];

  if (mode === "check") {
    deps.log(formatCheckReport({ liveDatabase: deps.liveDatabase, readOnlyDatabase: deps.readOnlyDatabase, root, target, execPath: deps.execPath, args, childEnv, droppedKeys }));
    return 0;
  }

  // 実DBへの接続の許可（スクリプトでは常に無効。接続・子プロセスの起動の前に止まる）
  if (deps.liveDatabase.mode !== "enabled") {
    throw new TestDbMigrateError(
      "TESTDB_MIGRATION_LIVE_DISABLED",
      "live database access is disabled in this build; refusing to connect to the test database or start the Prisma CLI.",
    );
  }
  const { inspectDatabase, readDockerIdentity } = deps.liveDatabase;

  // 照合1・2. Docker の安全条件と識別情報 D1（読み取りだけ。安全条件は readDockerIdentity の中で確かめる）
  const docker1 = await readDockerOrStop(readDockerIdentity, "before the database check");

  // 9〜11. 読み取り専用の接続・本人確認・状態の判定・権限・DB の識別情報 F1
  const { state: before, privileges, server: server1 } = await inspectOrStop(inspectDatabase, checkInput, "STATE_CHECK_FAILED");
  // 照合3・4. F1 だけで分かる不一致と、D1 との照合（アドレスの一致は記録だけ）
  const identityMismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
  if (identityMismatches.length > 0) {
    throw new TestDbMigrateError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${identityMismatches.join(", ")}); the Prisma CLI was not started.`);
  }
  if (before.state === "B") {
    deps.log(["[testdb-migrate] state B (partially applied, failed or unexpected objects):", ...before.reasons.map((r) => `  - ${r}`)].join("\n"));
    throw new TestDbMigrateError(
      "DATABASE_STATE_INCONSISTENT",
      "the test database is neither empty nor fully migrated; the Prisma CLI was not started. Nothing was reset or repaired.",
    );
  }
  if (before.state === "C") {
    deps.log(
      `[testdb-migrate] state C: all ${before.migrations.length} expected migrations are already applied and the tables are empty; ` +
        "the Prisma CLI was not started. Column, index and constraint definitions were not compared (schema diff not verified; Step 3-12).",
    );
    return 0;
  }

  // 12. A のときだけ。必要な権限がすべてあることを確かめてから、固定のコマンドで migrate deploy（Prisma CLI は自分で別の接続を作る）
  const missing = missingMigrationPrivileges(privileges);
  if (missing.length > 0) {
    deps.log(["[testdb-migrate] state A, but migration privileges are missing:", ...formatPrivileges(privileges).map((line) => `  ${line}`)].join("\n"));
    throw new TestDbMigrateError(
      "MIGRATION_PRIVILEGES_INSUFFICIENT",
      `${EXPECTED_USER} lacks privileges required for migrations (${missing.join(", ")}); the Prisma CLI was not started. Nothing was granted or changed.`,
    );
  }
  // 照合5・6. Prisma CLI の直前に D2 を読み、D1 と一致したときだけ起動する
  assertSameDocker(docker1, await readDockerOrStop(readDockerIdentity, "before the Prisma CLI"), "DOCKER_IDENTITY_MISMATCH");
  deps.log(
    `[testdb-migrate] identity checks passed (container ${docker1.containerId.slice(0, 12)}, inet_server_port ${server1.serverPort}, ` +
      `inet_server_addr ${addressMatchesContainer(server1, docker1) ? "matches" : "does not match"} the container network address; recorded only).`,
  );
  let exitCode: number;
  try {
    exitCode = await deps.spawn(deps.execPath, args, { cwd: root, env: childEnv, shell: false, stdio: "inherit" });
  } catch {
    throw new TestDbMigrateError("MIGRATION_FAILED", "the Prisma CLI could not be started. Nothing was reset.");
  }
  if (exitCode !== 0) {
    throw new TestDbMigrateError("MIGRATION_FAILED", `prisma migrate deploy exited with code ${exitCode}. Nothing was reset; check the database state before retrying.`);
  }

  // 13. migration の後に、別の接続でもう一度、本人確認と状態の判定。照合7〜9. F2 = F1、D3 = D1
  const { state: after, server: server2 } = await inspectOrStop(inspectDatabase, checkInput, "POST_MIGRATION_CHECK_FAILED");
  const serverChanges = serverIdentityChanges(server1, server2);
  if (serverChanges.length > 0) {
    throw new TestDbMigrateError(
      "POST_MIGRATION_IDENTITY_MISMATCH",
      `the database server changed during the migration (${serverChanges.join(", ")}). Nothing was reset or repaired.`,
    );
  }
  assertSameDocker(docker1, await readDockerOrStop(readDockerIdentity, "after the migration"), "POST_MIGRATION_IDENTITY_MISMATCH");
  if (after.state !== "C") {
    if (after.state === "B") deps.log(["[testdb-migrate] post-migration state B:", ...after.reasons.map((r) => `  - ${r}`)].join("\n"));
    throw new TestDbMigrateError(
      "POST_MIGRATION_STATE_MISMATCH",
      `after prisma migrate deploy, the test database is in state ${after.state}, not C. Nothing was reset.`,
    );
  }

  // 14. C
  deps.log(
    `[testdb-migrate] migrations applied; post-migration state C (${after.migrations.length} migrations, empty tables). ` +
      "Column, index and constraint definitions were not compared (schema diff not verified; Step 3-12).",
  );
  return 0;
}
