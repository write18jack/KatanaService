import path from "node:path";
import {
  assertReadOnlyTestDatabaseCredentials,
  assertReadOnlyTestDatabaseTarget,
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  ReadOnlyTestDatabaseCredentialsError,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck.ts";
import { DEVELOPMENT_ENV_FILE, TEST_ENV_FILE } from "./integrationEnv.ts";
import {
  assertCatalogFingerprintUnchanged,
  CATALOG_FINGERPRINT_SECTIONS,
  CatalogAuditError,
  type CatalogAuditExpectation,
  type CatalogDefinitionAuditResult,
  type CatalogFingerprint,
} from "./testDbCatalogAudit.ts";
import { dockerIdentityChanges, type PinnedServerExpectation, serverDockerMismatches, serverIdentityChanges, serverIdentityMismatches } from "./testDbIdentity.ts";
import type { InspectDatabase, ReadDockerIdentity } from "./testDbMigrate.ts";
import {
  assertReadOnlyRoleExecArgs,
  assertReadOnlyRoleFingerprintChange,
  buildReadOnlyRoleExecArgs,
  buildReadOnlyRoleExecEnv,
  classifyReadOnlyRoleBase,
  classifyReadOnlyRoleFull,
  createScramVerifier,
  encodeTableList,
  EXPECTED_INITIAL_TABLE_COUNT,
  expectedReadOnlyRoleTables,
  initialCreationPreconditionViolations,
  loadReadOnlyRoleSql,
  READ_ONLY_ROLE_ENV_FILE,
  READ_ONLY_ROLE_SQL_FILES,
  ReadOnlyRoleError,
  type ReadOnlyRoleCreateAccess,
  type ReadOnlyRoleGrantSyncAccess,
  type ReadOnlyRoleObservation,
  type ReadOnlyRoleOperation,
  sha256Hex,
  tablesWithoutAcl,
} from "./testDbReadOnlyRole.ts";
import type { TestDatabaseInspection } from "./testDbState.ts";

/**
 * 読み取り専用ロール katana_test_ro の準備の実行手順（Step 3-12B-5E-3。scripts/testdb-ro-role.mts の本体）。
 *
 *   npm run testdb:ro-role:create        … 予行（--create）。事前の検証と、実行予定の docker exec の表示だけ（Docker・DB に触れない）
 *   npm run testdb:ro-role:grant-sync    … 予行（--grant-sync）。同上
 *   node scripts/testdb-ro-role.mts --create --apply / --grant-sync --apply
 *                                        … 実行の意思表示。操作ごとの固定のゲートが無効なので、今は Docker・DB に触れる前に止まる
 *
 * 2つの操作は別々のゲート（RO_ROLE_CREATE_DISABLED・RO_ROLE_GRANT_SYNC_DISABLED）。ゲートは引数・環境変数では変えられない。
 * このモジュールは、DB ドライバ・Docker のコマンド・子プロセスを直接読み込まない（スクリプトから注入する）。
 *
 * create（--apply・ゲートが有効なときだけ）:
 *   D1 → F1（katana_test_user。状態 C・migration 8件・識別情報）→ FP0（カタログの監査。passed・fingerprint）→ FP0 の前提（ロールがない・ACL が未設定）
 *   → D2（D1 と一致）→ docker exec（01-create.sql）→ D3 → F2（状態 C・F1 と同じサーバー）→ FP1（FP0 からの想定した差分だけ）→ R-full
 * grant-sync（同上）:
 *   D1 → F1 → FP0 → R-base（katana_test_ro。補完の対象 = SELECT がなく ACL が未設定の、期待するテーブル）
 *   → 対象が0件なら、docker exec をせず、R-full が通ったときだけ成功
 *   → D2 → docker exec（02-grant-sync.sql）→ D3 → F2 → FP1（補完したテーブルの ACL だけ）→ R-full
 * docker exec を試みた後は、成功・失敗にかかわらず D3・F2・FP1 を行う（exec が失敗したときは、FP1 が FP0 と同じことを確かめる）。
 * どの検査の失敗でも、自動の復旧・再試行・再構築はしない。表示には、接続URL・パスワード・検証子・ハッシュを含めない。
 */

export type TestDbReadOnlyRoleErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "DOCKER_TARGET_ENV_PRESENT"
  | "TEST_ENV_MISSING"
  | "READ_ONLY_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "READ_ONLY_TARGET_REJECTED"
  | "READ_ONLY_CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "REQUIRED_FILE_MISSING"
  | "SQL_FILE_REJECTED"
  | "EXPECTATION_INVALID"
  | "MIGRATION_COUNT_MISMATCH"
  | "TABLE_COUNT_MISMATCH"
  | "RO_ROLE_CREATE_DISABLED"
  | "RO_ROLE_GRANT_SYNC_DISABLED"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "DATABASE_STATE_NOT_C"
  | "MIGRATION_LIST_MISMATCH"
  | "CATALOG_CHECK_FAILED"
  | "PRECONDITION_FAILED"
  | "READ_ONLY_ROLE_CHECK_FAILED"
  | "READ_ONLY_ROLE_BASE_FAILED"
  | "GRANT_TARGETS_MISMATCH"
  | "EXEC_REJECTED"
  | "EXEC_FAILED"
  | "EXEC_FAILED_STATE_CHANGED"
  | "POST_CHECK_FAILED"
  | "POST_IDENTITY_MISMATCH"
  | "POST_STATE_MISMATCH"
  | "POST_FINGERPRINT_MISMATCH"
  | "READ_ONLY_ROLE_FULL_FAILED";

export class TestDbReadOnlyRoleError extends Error {
  readonly code: TestDbReadOnlyRoleErrorCode;

  constructor(code: TestDbReadOnlyRoleErrorCode, detail: string) {
    super(`[testdb-ro-role] ${code}: ${detail}`);
    this.name = "TestDbReadOnlyRoleError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
type CheckInput = { databaseUrl: string; developmentDatabaseUrl: string | undefined };

/** 期待する migration の件数（lib/testing/testDbChecksums.ts の EXPECTED_MIGRATION_COUNT と同じ値。テストで一致を確かめる） */
export const EXPECTED_RO_ROLE_MIGRATION_COUNT = 8;
/** docker exec の終了を待つ上限。超えたら呼び出し側が子プロセスを止め、timeout を返す */
export const RO_ROLE_EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 2_000;

export type ReadOnlyRoleExecOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  /** 標準入力に渡す内容（固定の SQL ファイルの中身だけ） */
  readonly input: string;
  readonly timeoutMs: number;
};

export type ReadOnlyRoleExecResult =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "spawn-error"; readonly errorCode: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string };

export type TestDbReadOnlyRoleDeps = {
  root: string;
  /** process.argv.slice(2) */
  argv: readonly string[];
  execArgv: readonly string[];
  parentEnv: EnvSource;
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** 固定の SQL ファイルを読む（SHA-256 を照合してから使う） */
  readFile: (absolutePath: string) => string;
  loadExpectation: () => CatalogAuditExpectation;
  /** 操作1のゲート（固定）。--create --apply のときだけ、事前の検証の後で確かめる */
  createGate: ReadOnlyRoleCreateAccess;
  /** 操作2のゲート（固定）。--grant-sync --apply のときだけ確かめる */
  grantSyncGate: ReadOnlyRoleGrantSyncAccess;
  readDockerIdentity: ReadDockerIdentity;
  /** F1・F2（katana_test_user の読み取り専用の接続） */
  inspectDatabase: InspectDatabase;
  /** FP0・FP1（runCatalogDefinitionAudit。katana_test_user の読み取り専用の接続） */
  runAudit: (input: CheckInput & { expectation: CatalogAuditExpectation; expectedServer: PinnedServerExpectation }) => Promise<CatalogDefinitionAuditResult>;
  /** R-base・R-full（runReadOnlyRoleCheck。katana_test_ro の読み取り専用の接続） */
  checkReadOnlyRole: (input: CheckInput & { expectedServer: PinnedServerExpectation }) => Promise<ReadOnlyRoleObservation>;
  /** 固定の docker exec を、shell なし・標準入力付きで起動する */
  exec: (command: string, args: readonly string[], options: ReadOnlyRoleExecOptions) => Promise<ReadOnlyRoleExecResult>;
  /** 検証子の作成（既定は createScramVerifier。テストでだけ差し替える） */
  createVerifier?: (password: string) => string;
  log: (text: string) => void;
};

export type TestDbReadOnlyRoleCommand = { operation: ReadOnlyRoleOperation; apply: boolean };

export type TestDbReadOnlyRoleOutcome =
  | { readonly mode: "dry-run"; readonly operation: ReadOnlyRoleOperation }
  | { readonly mode: "applied"; readonly operation: ReadOnlyRoleOperation; readonly grantedTables: readonly string[] }
  | { readonly mode: "nothing-to-do"; readonly operation: "grant-sync" };

const COMMANDS: readonly [readonly string[], TestDbReadOnlyRoleCommand][] = [
  [["--create"], { operation: "create", apply: false }],
  [["--create", "--apply"], { operation: "create", apply: true }],
  [["--grant-sync"], { operation: "grant-sync", apply: false }],
  [["--grant-sync", "--apply"], { operation: "grant-sync", apply: true }],
];

/** 引数は固定の4通りだけ。それ以外（引数なし・未知の引数・順序の違い）は、何にも触れる前に止める */
export function parseTestDbReadOnlyRoleArgs(args: readonly string[]): TestDbReadOnlyRoleCommand {
  const match = COMMANDS.find(([expected]) => expected.length === args.length && expected.every((arg, i) => arg === args[i]));
  if (!match) {
    throw new TestDbReadOnlyRoleError("ARGUMENTS_INVALID", "use --create or --grant-sync (dry run), optionally followed by --apply.");
  }
  return { ...match[1] };
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]*$/;

function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError || error instanceof CatalogAuditError || error instanceof ReadOnlyRoleError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : "unknown";
}

/** 出力から秘密の値と接続URLを伏せ、長さを制限する */
export function redactExecOutput(text: string, secrets: readonly string[]): string {
  let result = text.replace(/postgres(?:ql)?:\/\/[^\s"'`]*/gi, "postgresql://(hidden)");
  for (const secret of [...secrets].filter((s) => s !== "").sort((a, b) => b.length - a.length)) result = result.split(secret).join("(hidden)");
  result = result.replace(/SCRAM-SHA-256\$[^\s"'`]*/g, "(hidden)");
  return result.length > MAX_OUTPUT ? `${result.slice(0, MAX_OUTPUT)}… (output truncated)` : result;
}

/** exec の結果のうち、成功は「終了コード0・シグナルなし」だけ */
function execSucceeded(result: ReadOnlyRoleExecResult): boolean {
  return result.kind === "exit" && result.code === 0 && result.signal === null;
}

function describeExec(result: ReadOnlyRoleExecResult, secrets: readonly string[]): string {
  if (result.kind === "spawn-error") return `docker could not be started (${SAFE_CODE.test(result.errorCode) ? result.errorCode : "unknown"})`;
  const output = redactExecOutput([result.stdout, result.stderr].filter((s) => s !== "").join("\n").trim(), secrets);
  if (result.kind === "timeout") return `docker exec timed out${output ? `: ${output}` : ""}`;
  if (result.signal !== null) return `docker exec ended by a signal`;
  // 3：SQL のエラー（ON_ERROR_STOP。ROLLBACK 済み）、2：接続の切断（COMMIT したかは不明）、1：psql の致命的なエラー、125〜127：docker exec 自体の失敗
  const meaning =
    result.code === 3 ? "SQL error; the transaction was rolled back" : result.code === 2 ? "connection lost; whether the transaction committed is unknown" : "exec failed";
  return `docker exec exited with ${result.code ?? "no code"} (${meaning})${output ? `: ${output}` : ""}`;
}

const AFTER_NOTE = "docker exec was already attempted, so this is detection after the fact. Nothing was reset or repaired.";

/** 手順どおりに検証し、実行する。成功なら結果を返し、どれか1つでも失敗したら TestDbReadOnlyRoleError を投げる */
export async function runTestDbReadOnlyRole(deps: TestDbReadOnlyRoleDeps): Promise<TestDbReadOnlyRoleOutcome> {
  const { root } = deps;
  const { operation, apply } = parseTestDbReadOnlyRoleArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new TestDbReadOnlyRoleError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbReadOnlyRoleError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running this script.");
  }
  const dockerTarget = ["DOCKER_HOST", "DOCKER_CONTEXT"].filter((key) => deps.parentEnv[key] !== undefined);
  if (dockerTarget.length > 0) throw new TestDbReadOnlyRoleError("DOCKER_TARGET_ENV_PRESENT", `unset ${dockerTarget.join(", ")} before running this script.`);

  // ---- 事前の検証（ファイルだけ。Docker・DB に触れない） ----
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new TestDbReadOnlyRoleError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentDatabaseUrl = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE))?.DATABASE_URL;
  const guard = (url: string | undefined, env: EnvSource, code: "TARGET_REJECTED" | "UNSAFE_PARENT_ENV" | "READ_ONLY_TARGET_REJECTED", readOnly = false): TestDatabaseTarget => {
    try {
      return (readOnly ? assertReadOnlyTestDatabaseTarget : assertTestDatabaseTarget)({ databaseUrl: url, env, developmentDatabaseUrl });
    } catch (error) {
      if (error instanceof TestDatabaseGuardError) {
        throw new TestDbReadOnlyRoleError(
          code,
          code === "UNSAFE_PARENT_ENV" ? `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.` : `the target was rejected (${error.code}).`,
        );
      }
      throw error;
    }
  };
  const appTarget = guard(testEnv.DATABASE_URL, {}, "TARGET_REJECTED");
  let passwords: { appPassword: string; adminPassword: string };
  try {
    passwords = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) throw new TestDbReadOnlyRoleError("CREDENTIALS_REJECTED", `the credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    throw error;
  }
  const appUrl = testEnv.DATABASE_URL as string;
  guard(appUrl, deps.parentEnv, "UNSAFE_PARENT_ENV");

  const readOnlyEnv = deps.readEnvFile(path.join(root, READ_ONLY_ROLE_ENV_FILE));
  if (readOnlyEnv === undefined) throw new TestDbReadOnlyRoleError("READ_ONLY_ENV_MISSING", `${READ_ONLY_ROLE_ENV_FILE} was not found.`);
  const readOnlyTarget = guard(readOnlyEnv.KATANA_TEST_RO_DATABASE_URL, {}, "READ_ONLY_TARGET_REJECTED", true);
  let readOnly: { databaseUrl: string; password: string };
  try {
    readOnly = assertReadOnlyTestDatabaseCredentials(readOnlyEnv, { databaseUrl: appUrl, ...passwords });
  } catch (error) {
    if (error instanceof ReadOnlyTestDatabaseCredentialsError) {
      throw new TestDbReadOnlyRoleError("READ_ONLY_CREDENTIALS_REJECTED", `the credentials in ${READ_ONLY_ROLE_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const appCheck: CheckInput = { databaseUrl: appUrl, developmentDatabaseUrl };
  const roCheck: CheckInput = { databaseUrl: readOnly.databaseUrl, developmentDatabaseUrl };

  for (const relative of [path.join("prisma", "schema.prisma"), path.join("prisma", "migrations"), READ_ONLY_ROLE_SQL_FILES[operation]]) {
    if (!deps.pathExists(path.join(root, relative))) throw new TestDbReadOnlyRoleError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }
  let sql: string;
  try {
    sql = loadReadOnlyRoleSql(root, operation, deps.readFile);
  } catch (error) {
    throw new TestDbReadOnlyRoleError("SQL_FILE_REJECTED", `the fixed SQL file was rejected (${codeOf(error)}); nothing was executed.`);
  }

  let expectation: CatalogAuditExpectation;
  try {
    expectation = deps.loadExpectation();
  } catch (error) {
    throw new TestDbReadOnlyRoleError("EXPECTATION_INVALID", `the expectation could not be built from the repository files (${codeOf(error)}).`);
  }
  if (expectation.inventory.migrations.length !== EXPECTED_RO_ROLE_MIGRATION_COUNT) {
    throw new TestDbReadOnlyRoleError("MIGRATION_COUNT_MISMATCH", `expected ${EXPECTED_RO_ROLE_MIGRATION_COUNT} local migrations, found ${expectation.inventory.migrations.length}.`);
  }
  // テーブルの一覧（expected_tables）。create は16件ちょうど、grant-sync は schema.prisma から作った件数（固定しない。状態 C の判定で DB と照合する）
  const tables = expectedReadOnlyRoleTables(expectation);
  let expectedTables: string;
  try {
    expectedTables = encodeTableList(tables);
  } catch (error) {
    throw new TestDbReadOnlyRoleError("EXPECTATION_INVALID", `the expected table list is invalid (${codeOf(error)}).`);
  }
  if (operation === "create" && tables.length !== EXPECTED_INITIAL_TABLE_COUNT) {
    throw new TestDbReadOnlyRoleError("TABLE_COUNT_MISMATCH", `the initial creation expects exactly ${EXPECTED_INITIAL_TABLE_COUNT} tables, found ${tables.length}; use --grant-sync for added tables.`);
  }

  const where = `${appTarget.host}:${appTarget.port}/${appTarget.database}`;
  const gateEnabled = operation === "create" ? deps.createGate.mode === "enabled-create" : deps.grantSyncGate.mode === "enabled-grant-sync";
  if (!apply) {
    const preview = buildReadOnlyRoleExecArgs(operation, "0".repeat(64)).map((arg) => (arg === "0".repeat(64) ? "<container id from D1>" : arg));
    deps.log(
      [
        `[testdb-ro-role] dry run of ${operation} (--apply was not given): Docker was not read and no database connection was made.`,
        `test database: ${where}; application role ${appTarget.user} and read-only role ${readOnlyTarget.user} verified (passwords hidden)`,
        `fixed SQL: ${READ_ONLY_ROLE_SQL_FILES[operation]} (SHA-256 verified)`,
        `expected tables: ${tables.length}${operation === "create" ? ` (initial creation requires exactly ${EXPECTED_INITIAL_TABLE_COUNT})` : ""}`,
        `planned command: docker ${preview.join(" ")}  (SQL on standard input; values in the -e variables are not shown)`,
        `${operation} gate: ${gateEnabled ? "enabled" : `disabled in this build (--apply stops with ${operation === "create" ? "RO_ROLE_CREATE_DISABLED" : "RO_ROLE_GRANT_SYNC_DISABLED"} before reading Docker or connecting)`}`,
      ].join("\n"),
    );
    return { mode: "dry-run", operation };
  }

  // ---- ここからは --apply だけ。操作ごとの固定のゲートが無効なら、Docker・DB に触れずに止まる ----
  if (operation === "create" && deps.createGate.mode !== "enabled-create") {
    throw new TestDbReadOnlyRoleError("RO_ROLE_CREATE_DISABLED", "creating the read-only role is disabled in this build; refusing to read Docker or connect to the test database.");
  }
  if (operation === "grant-sync" && deps.grantSyncGate.mode !== "enabled-grant-sync") {
    throw new TestDbReadOnlyRoleError("RO_ROLE_GRANT_SYNC_DISABLED", "granting missing privileges to the read-only role is disabled in this build; refusing to read Docker or connect to the test database.");
  }

  const readDocker = async (label: "D1" | "D2" | "D3") => {
    try {
      return await deps.readDockerIdentity({ root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile });
    } catch (error) {
      throw new TestDbReadOnlyRoleError(label === "D3" ? "POST_CHECK_FAILED" : "DOCKER_IDENTITY_FAILED", `the docker identity check ${label} failed (${codeOf(error)}).${label === "D3" ? ` ${AFTER_NOTE}` : ""}`);
    }
  };
  const inspect = async (label: "F1" | "F2"): Promise<TestDatabaseInspection> => {
    try {
      return await deps.inspectDatabase(appCheck);
    } catch (error) {
      throw new TestDbReadOnlyRoleError(label === "F1" ? "STATE_CHECK_FAILED" : "POST_CHECK_FAILED", `the database check ${label} failed (${codeOf(error)}).${label === "F2" ? ` ${AFTER_NOTE}` : ""}`);
    }
  };
  const fingerprint = async (label: "FP0" | "FP1", expectedServer: PinnedServerExpectation): Promise<CatalogFingerprint> => {
    const code = label === "FP0" ? "CATALOG_CHECK_FAILED" : "POST_CHECK_FAILED";
    let result: CatalogDefinitionAuditResult;
    try {
      result = await deps.runAudit({ ...appCheck, expectation, expectedServer });
    } catch (error) {
      throw new TestDbReadOnlyRoleError(code, `the catalog check ${label} failed (${codeOf(error)}).${label === "FP1" ? ` ${AFTER_NOTE}` : ""}`);
    }
    if (result.report.verdict !== "passed") throw new TestDbReadOnlyRoleError(code, `the catalog audit ${label} did not pass (${result.report.verdict}).`);
    if (Object.keys(result.fingerprint.sections).length !== Object.keys(CATALOG_FINGERPRINT_SECTIONS).length) {
      throw new TestDbReadOnlyRoleError(code, `the catalog fingerprint ${label} is incomplete.`);
    }
    return result.fingerprint;
  };
  const checkRole = async (label: "R-base" | "R-full", expectedServer: PinnedServerExpectation): Promise<ReadOnlyRoleObservation> => {
    try {
      return await deps.checkReadOnlyRole({ ...roCheck, expectedServer });
    } catch (error) {
      throw new TestDbReadOnlyRoleError(label === "R-base" ? "READ_ONLY_ROLE_CHECK_FAILED" : "POST_CHECK_FAILED", `the read-only role check ${label} failed (${codeOf(error)}).`);
    }
  };

  // D1 → F1（本人確認・状態 C・migration・識別情報・D1 との整合）
  const docker1 = await readDocker("D1");
  const { state, server: server1 } = await inspect("F1");
  const mismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
  if (mismatches.length > 0) throw new TestDbReadOnlyRoleError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${mismatches.join(", ")}).`);
  if (state.state !== "C") throw new TestDbReadOnlyRoleError("DATABASE_STATE_NOT_C", `the test database is in state ${state.state}, not C.`);
  const sameNames = (a: readonly string[], b: readonly string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");
  if (!sameNames(state.migrations, expectation.inventory.migrations)) throw new TestDbReadOnlyRoleError("MIGRATION_LIST_MISMATCH", "the applied migrations do not match the local migrations.");
  const expectedServer: PinnedServerExpectation = { docker: docker1, server: server1 };

  // FP0（定義の監査が passed・fingerprint 18区分）
  const fp0 = await fingerprint("FP0", expectedServer);

  // 操作ごとの前提と、付与の対象（grant_targets）
  let grantTargets: string[];
  if (operation === "create") {
    const violations = initialCreationPreconditionViolations(fp0, tables);
    if (violations.length > 0) throw new TestDbReadOnlyRoleError("PRECONDITION_FAILED", `the initial creation cannot start (${violations.join(", ")}). Nothing was changed.`);
    grantTargets = [...tables];
  } else {
    const base = classifyReadOnlyRoleBase(await checkRole("R-base", expectedServer), tables);
    if (!base.passed) throw new TestDbReadOnlyRoleError("READ_ONLY_ROLE_BASE_FAILED", `the read-only role is not in the expected state (${base.findings.join("; ")}). Nothing was changed.`);
    const withoutAcl = tablesWithoutAcl(fp0, tables);
    if (base.candidates.join(",") !== withoutAcl.join(",")) {
      throw new TestDbReadOnlyRoleError("GRANT_TARGETS_MISMATCH", "the tables without SELECT do not match the tables without privileges in the catalog. Nothing was changed.");
    }
    if (base.candidates.length === 0) {
      // 補完の対象が0件：docker exec はしない。同じ観測で R-full が通ったときだけ成功
      const full = classifyReadOnlyRoleFull(await checkRole("R-full", expectedServer), tables);
      if (!full.passed) throw new TestDbReadOnlyRoleError("READ_ONLY_ROLE_FULL_FAILED", `the read-only role check did not pass (${full.findings.join("; ")}). Nothing was changed.`);
      deps.log(`[testdb-ro-role] grant-sync: no tables are missing SELECT; docker exec was not run. R-full passed (${tables.length} tables).`);
      return { mode: "nothing-to-do", operation: "grant-sync" };
    }
    grantTargets = [...base.candidates];
  }

  // D2（D1 と一致）
  const docker2 = await readDocker("D2");
  const changedBefore = dockerIdentityChanges(docker1, docker2);
  if (changedBefore.length > 0) {
    throw new TestDbReadOnlyRoleError("DOCKER_IDENTITY_MISMATCH", `the test database container changed (${changedBefore.join(", ")}); docker exec was not started.`);
  }

  // 固定の docker exec の組み立てと照合（Container ID は D1・D2 の値）
  const secrets = [appUrl, passwords.appPassword, passwords.adminPassword, readOnly.databaseUrl, readOnly.password];
  let args: readonly string[];
  let env: Record<string, string>;
  try {
    const verifier = operation === "create" ? (deps.createVerifier ?? createScramVerifier)(readOnly.password) : undefined;
    const verifierSha256 = verifier === undefined ? undefined : sha256Hex(verifier);
    if (verifier !== undefined && verifierSha256 !== undefined) secrets.push(verifier, verifierSha256);
    env = buildReadOnlyRoleExecEnv(deps.parentEnv, operation, {
      postmasterStart: server1.postmasterStartTime,
      expectedTables,
      grantTargets: encodeTableList(grantTargets),
      verifier,
      verifierSha256,
    });
    args = buildReadOnlyRoleExecArgs(operation, docker1.containerId);
    assertReadOnlyRoleExecArgs(args, operation, docker1, docker2);
  } catch (error) {
    throw new TestDbReadOnlyRoleError("EXEC_REJECTED", `the docker exec could not be prepared (${codeOf(error)}); docker exec was not started.`);
  }

  let result: ReadOnlyRoleExecResult;
  try {
    result = await deps.exec("docker", args, { cwd: root, env, shell: false, input: sql, timeoutMs: RO_ROLE_EXEC_TIMEOUT_MS });
  } catch (error) {
    result = { kind: "spawn-error", errorCode: codeOf(error) };
  }
  const succeeded = execSucceeded(result);

  // ---- 事後の検査（exec の成否にかかわらず行う） ----
  const changedAfter = dockerIdentityChanges(docker1, await readDocker("D3"));
  if (changedAfter.length > 0) throw new TestDbReadOnlyRoleError("POST_IDENTITY_MISMATCH", `the test database container changed (${changedAfter.join(", ")}). ${AFTER_NOTE}`);
  const { state: after, server: server2 } = await inspect("F2");
  const serverChanges = serverIdentityChanges(server1, server2);
  if (serverChanges.length > 0) throw new TestDbReadOnlyRoleError("POST_IDENTITY_MISMATCH", `the database server changed (${serverChanges.join(", ")}). ${AFTER_NOTE}`);
  if (after.state !== "C") throw new TestDbReadOnlyRoleError("POST_STATE_MISMATCH", `the test database is in state ${after.state}, not C. ${AFTER_NOTE}`);
  const fp1 = await fingerprint("FP1", expectedServer);

  if (!succeeded) {
    const detail = describeExec(result, secrets);
    try {
      assertCatalogFingerprintUnchanged(fp0, fp1);
    } catch {
      throw new TestDbReadOnlyRoleError("EXEC_FAILED_STATE_CHANGED", `${detail}; the catalog differs from before the attempt. ${AFTER_NOTE}`);
    }
    throw new TestDbReadOnlyRoleError("EXEC_FAILED", `${detail}; the catalog is unchanged from before the attempt (verified after the fact).`);
  }
  try {
    assertReadOnlyRoleFingerprintChange(fp0, fp1, { operation, grantedTables: grantTargets });
  } catch (error) {
    const detail = error instanceof ReadOnlyRoleError ? error.message.replace(/^\[readOnlyRole\] [A-Z_]+: /, "") : codeOf(error);
    throw new TestDbReadOnlyRoleError("POST_FINGERPRINT_MISMATCH", `${detail} ${AFTER_NOTE}`);
  }
  const full = classifyReadOnlyRoleFull(await checkRole("R-full", expectedServer), tables);
  if (!full.passed) throw new TestDbReadOnlyRoleError("READ_ONLY_ROLE_FULL_FAILED", `the read-only role check did not pass (${full.findings.join("; ")}). ${AFTER_NOTE}`);

  deps.log(
    [
      `[testdb-ro-role] ${operation} applied to ${where}: ${grantTargets.length} tables granted SELECT for ${readOnlyTarget.user} (passwords and values hidden).`,
      "checks D1/F1/FP0/D2 before and D3/F2/FP1/R-full after passed; state C before and after; only the expected catalog changes were found.",
    ].join("\n"),
  );
  return { mode: "applied", operation, grantedTables: grantTargets };
}
