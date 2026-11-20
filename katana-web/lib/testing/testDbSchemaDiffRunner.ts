import path from "node:path";
import { READ_ONLY_TEST_ENV_FILE, SCHEMA_DIFF_CONFIG_FILE, SCHEMA_DIFF_SCHEMA_FILE } from "../db/prismaCliGuard.ts";
import {
  assertReadOnlyTestDatabaseCredentials,
  assertReadOnlyTestDatabaseTarget,
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  ReadOnlyTestDatabaseCredentialsError,
  TEST_DB_RO_URL_KEY,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck.ts";
import { DEVELOPMENT_ENV_FILE, TEST_ENV_FILE } from "./integrationEnv.ts";
import {
  assertSchemaDiffBinaries,
  assertSchemaDiffCommand,
  buildSchemaDiffCommand,
  buildSchemaDiffEnv,
  buildSchemaDiffSpawnOptions,
  classifySchemaDiffResult,
  SCHEMA_DIFF_BINARY_SHA256,
  SCHEMA_DIFF_SCOPE_NOTE,
  type SchemaDiffAccess,
  SchemaDiffError,
  type SchemaDiffInterrupts,
  type SchemaDiffInterruptSignal,
  schemaDiffEnvViolations,
  type SchemaDiffOutcome,
  type SchemaDiffProcessGroupState,
  type SchemaDiffProcessResult,
  type SchemaDiffSpawnOptions,
} from "./schemaDiff.ts";
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
  classifyReadOnlyRoleFull,
  createdAclViolations,
  createdCatalogViolations,
  expectedReadOnlyRoleTables,
  type PreChangeAclObservation,
  ReadOnlyRoleError,
  type ReadOnlyRoleObservation,
  readOnlyRoleExistsIn,
} from "./testDbReadOnlyRole.ts";
import type { TestDatabaseInspection } from "./testDbState.ts";

/**
 * schemaDiff の実行手順（Step 3-12B-5E-9A-9-2。方式A：Prisma CLI と専用の設定ファイル。scripts/testdb-schema-diff.mts の本体）。
 *
 *   npm run testdb:schema-diff            … 予行（引数なし）。事前の検証と、実行予定のコマンドの表示だけ（Docker・DB・Prisma CLI に触れない）
 *   node scripts/testdb-schema-diff.mts --live
 *                                         … 実行の意思表示。固定のゲート SCHEMA_DIFF_DISABLED が無効なので、今は Docker・DB・
 *                                           Prisma CLI に触れる前に止まる
 *
 * このモジュールは、DB ドライバ・Docker のコマンド・子プロセスを直接読み込まない（スクリプトから注入する）。
 *
 * 事前の検証（ファイルだけ。Docker・DB・子プロセスに触れない）:
 *   引数 → Node の起動オプション・NODE_OPTIONS・DOCKER_HOST/DOCKER_CONTEXT → `.env.test`（katana_test_user。F1・FP・A1 に使う）
 *   → 親の PG*・DOTENV_* → `.env.test.readonly`（katana_test_ro だけ。ほかのユーザー・開発用DB・クエリ付きの URL を拒否）
 *   → 必要なファイル → プラットフォームと CLI・engine の SHA-256 → 期待値（schema.prisma・migration）→ 子プロセスの環境変数の生成と検証
 *   → 固定のコマンドの照合 → （引数なしなら予行の表示で終わる）→ ゲート（無効なら、ここで止まる）
 * 実行（--live・ゲートが有効なときだけ）:
 *   D1 → F1（katana_test_user の読み取り専用の接続。本人・状態 C・migration・サーバーの識別）→ FP1（カタログの監査が passed・
 *   ロールが作成後の期待値どおり）→ A1（DB・スキーマの ACL が作成後の期待値どおり）→ R1（katana_test_ro 本人。SELECT だけ）
 *   → D2（D1 と一致）→ SHA-256 の再照合 → Prisma CLI（migrate diff）
 *   → 成否にかかわらず D3・F2・FP2（FP1 から変化なし）・R2 をすべて試す（1つが失敗しても残りを試す）→ 最終判定
 *
 * 中断（親のプロセスへの SIGINT・SIGTERM。scripts/testdb-schema-diff.mts の createSchemaDiffInterruptController）:
 *   CLI の起動の前：各段階の後で確かめ、CLI を起動せずに INTERRUPTED で止める（実行中の段階の失敗も INTERRUPTED として扱う）。
 *   CLI の起動の後：spawnCapture がプロセスグループに SIGTERM → SIGKILL を送り、終了を確かめる。その後 D3・F2・FP2・R2 を試し、
 *   判定は interrupted（1）。no-diff・diff にはしない。2回目の中断か上限を超えたら、事後の検査を打ち切って終了コード 1 で終わる。
 *
 * 最終判定（終了コード）:
 *   事後の検査がすべて通った：CLI 0 → no-diff（0）、CLI 2 → diff（2）、それ以外（1・起動失敗・タイムアウト・シグナル・想定外）→ cli-failed（1）
 *   事後の検査のどれかが失敗：post-check-failed（1）。DB が変わっていないことは保証しない（推測で「変わっていない」としない）
 *   CLI のプロセスグループの停止を確かめられなかった：cleanup-failed（1）。中断を受けた：interrupted（1）
 *   （優先順：post-check-failed → cleanup-failed → interrupted → CLI の結果）
 *
 * 表示・例外のメッセージには、接続URL・パスワードを含めない。CLI の出力は redactSecrets で伏せてから表示する。
 * 認証情報が schema engine のプロセス引数に出ること（方式Aの残余リスク）は、ここでは防げない（解消したものとは扱わない）。
 */

/** 期待する migration の件数（lib/testing/testDbChecksums.ts の EXPECTED_MIGRATION_COUNT と同じ値。テストで一致を確かめる） */
export const EXPECTED_SCHEMA_DIFF_MIGRATION_COUNT = 8;

type EnvSource = Readonly<Record<string, string | undefined>>;
type CheckInput = { databaseUrl: string; developmentDatabaseUrl: string | undefined };

export type TestDbSchemaDiffMode = "dry-run" | "live";

export type TestDbSchemaDiffDeps = {
  root: string;
  /** process.argv.slice(2) */
  argv: readonly string[];
  execArgv: readonly string[];
  /** 子プロセスで使う Node の実行ファイル（process.execPath） */
  execPath: string;
  platform: string;
  arch: string;
  parentEnv: EnvSource;
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** CLI のエントリ・engine の実体を読む（SHA-256 の照合だけに使う。実行しない） */
  readBinary: (absolutePath: string) => Uint8Array;
  loadExpectation: () => CatalogAuditExpectation;
  /** 固定のゲート（SCHEMA_DIFF_DISABLED）。--live のときだけ、事前の検証の後で確かめる */
  access: SchemaDiffAccess;
  readDockerIdentity: ReadDockerIdentity;
  /** F1・F2（katana_test_user の読み取り専用の接続） */
  inspectDatabase: InspectDatabase;
  /** FP1・FP2（runCatalogDefinitionAudit。katana_test_user の読み取り専用の接続） */
  runAudit: (input: CheckInput & { expectation: CatalogAuditExpectation; expectedServer: PinnedServerExpectation }) => Promise<CatalogDefinitionAuditResult>;
  /** R1・R2（runReadOnlyRoleCheck。katana_test_ro の読み取り専用の接続） */
  checkReadOnlyRole: (input: CheckInput & { expectedServer: PinnedServerExpectation }) => Promise<ReadOnlyRoleObservation>;
  /** A1（runPreChangeAclCheck。katana_test_user の読み取り専用の接続） */
  checkAcl: (input: CheckInput & { expectedServer: PinnedServerExpectation }) => Promise<PreChangeAclObservation>;
  /** 子プロセスを起動し、出力と終了を返す（createSchemaDiffSpawnCapture。タイムアウト・中断ではプロセスグループごと止める） */
  spawnCapture: (command: string, args: readonly string[], options: SchemaDiffSpawnOptions, interrupts: SchemaDiffInterrupts) => Promise<SchemaDiffProcessResult>;
  /** 親のプロセスへの SIGINT・SIGTERM（createSchemaDiffInterruptController） */
  interrupts: SchemaDiffInterrupts;
  /** 固定のコマンドの組み立て（単体テストで、改ざんされたコマンドが拒否されることを確かめるためだけに差し替える） */
  buildCommand?: typeof buildSchemaDiffCommand;
  log: (text: string) => void;
};

export type PostCheckLabel = "D3" | "F2" | "FP2" | "R2";
export type PostCheckResult = { readonly label: PostCheckLabel; readonly passed: boolean; readonly detail: string };

export type SchemaDiffVerdict = "no-diff" | "diff" | "cli-failed" | "interrupted" | "cleanup-failed" | "post-check-failed";

/** CLI のプロセスグループの後始末。not-started：起動しなかった（起動の失敗） */
export type SchemaDiffCleanupState = SchemaDiffProcessGroupState | "not-started";

export type TestDbSchemaDiffOutcome =
  | { readonly mode: "dry-run" }
  | {
      readonly mode: "live";
      readonly verdict: SchemaDiffVerdict;
      readonly exitCode: 0 | 1 | 2;
      readonly cli: SchemaDiffOutcome;
      readonly postChecks: readonly PostCheckResult[];
      readonly processGroup: SchemaDiffCleanupState;
      readonly interruptedBy: SchemaDiffInterruptSignal | undefined;
    };

const ACCEPTED_ARGS: readonly (readonly [readonly string[], TestDbSchemaDiffMode])[] = [
  [[], "dry-run"],
  [["--live"], "live"],
];

/** 引数は「なし」（予行）か `--live` の1つだけ。それ以外は、何にも触れる前に止める */
export function parseTestDbSchemaDiffArgs(args: readonly string[]): TestDbSchemaDiffMode {
  const match = ACCEPTED_ARGS.find(([expected]) => expected.length === args.length && expected.every((arg, i) => arg === args[i]));
  if (!match) throw new SchemaDiffError("ARGUMENTS_INVALID", "the only accepted argument is --live (no arguments is a dry run).");
  return match[1];
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]*$/;

function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError || error instanceof CatalogAuditError || error instanceof ReadOnlyRoleError || error instanceof SchemaDiffError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : "unknown";
}

/**
 * 最終判定（純粋関数）。成功は「事後の検査がすべて通り、CLI のプロセスグループの停止を確かめ、中断がなく、CLI が 0」だけ。
 * 差分あり（2）も、同じ条件がそろったときだけ。
 */
export function decideSchemaDiffVerdict(
  cli: SchemaDiffOutcome,
  postChecks: readonly PostCheckResult[],
  run: { readonly processGroup: SchemaDiffCleanupState; readonly interruptedBy: SchemaDiffInterruptSignal | undefined },
): { verdict: SchemaDiffVerdict; exitCode: 0 | 1 | 2 } {
  const labels: readonly PostCheckLabel[] = ["D3", "F2", "FP2", "R2"];
  const allPassed = labels.every((label) => postChecks.some((c) => c.label === label && c.passed)) && postChecks.every((c) => c.passed);
  if (!allPassed) return { verdict: "post-check-failed", exitCode: 1 };
  if (run.processGroup !== "stopped" && run.processGroup !== "not-started") return { verdict: "cleanup-failed", exitCode: 1 };
  if (run.processGroup === "not-started" && cli.outcome !== "spawn-failed") return { verdict: "cleanup-failed", exitCode: 1 };
  if (run.interruptedBy !== undefined || cli.outcome === "interrupted") return { verdict: "interrupted", exitCode: 1 };
  if (cli.outcome === "no-diff") return { verdict: "no-diff", exitCode: 0 };
  if (cli.outcome === "diff") return { verdict: "diff", exitCode: 2 };
  return { verdict: "cli-failed", exitCode: 1 };
}

/** 監査が passed で、fingerprint が18区分そろっていること。違えば、その理由（値を含まない）を返す */
function fingerprintProblem(result: CatalogDefinitionAuditResult, label: "FP1" | "FP2"): string | undefined {
  if (result.report.verdict !== "passed") return `the catalog audit ${label} did not pass (${result.report.verdict})`;
  if (Object.keys(result.fingerprint.sections).length !== Object.keys(CATALOG_FINGERPRINT_SECTIONS).length) return `the catalog fingerprint ${label} is incomplete`;
  return undefined;
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

const BEFORE_NOTE = "The Prisma CLI was not started.";
const AFTER_NOTE = "The Prisma CLI was already started, so this is detection after the fact; it is not guaranteed that the database is unchanged. Nothing was reset or repaired.";

/** 手順どおりに検証し、実行する。CLI の起動の前の失敗は SchemaDiffError を投げる。起動の後は、事後の検査の結果を含む判定を返す */
export async function runTestDbSchemaDiff(deps: TestDbSchemaDiffDeps): Promise<TestDbSchemaDiffOutcome> {
  const { root } = deps;
  const mode = parseTestDbSchemaDiffArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new SchemaDiffError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new SchemaDiffError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the schema diff.");
  }
  const dockerTarget = ["DOCKER_HOST", "DOCKER_CONTEXT"].filter((key) => deps.parentEnv[key] !== undefined);
  if (dockerTarget.length > 0) throw new SchemaDiffError("DOCKER_TARGET_ENV_PRESENT", `unset ${dockerTarget.join(", ")} before running the schema diff.`);

  // ---- 事前の検証（ファイルだけ。Docker・DB・子プロセスに触れない） ----
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new SchemaDiffError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentEnv = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE));
  const developmentDatabaseUrl = developmentEnv?.DATABASE_URL;
  const guard = (url: string | undefined, env: EnvSource, code: "TARGET_REJECTED" | "UNSAFE_PARENT_ENV" | "READ_ONLY_TARGET_REJECTED" | "CHILD_ENV_REJECTED", readOnly: boolean): TestDatabaseTarget => {
    try {
      return (readOnly ? assertReadOnlyTestDatabaseTarget : assertTestDatabaseTarget)({ databaseUrl: url, env, developmentDatabaseUrl });
    } catch (error) {
      if (error instanceof TestDatabaseGuardError) {
        const detail = code === "UNSAFE_PARENT_ENV" ? `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.` : `the target was rejected (${error.code}).`;
        throw new SchemaDiffError(code, `${detail} ${BEFORE_NOTE}`);
      }
      throw error;
    }
  };
  const appTarget = guard(testEnv.DATABASE_URL, {}, "TARGET_REJECTED", false);
  let passwords: { appPassword: string; adminPassword: string };
  try {
    passwords = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) throw new SchemaDiffError("CREDENTIALS_REJECTED", `the credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    throw error;
  }
  const appUrl = testEnv.DATABASE_URL as string;
  guard(appUrl, deps.parentEnv, "UNSAFE_PARENT_ENV", false);

  const readOnlyEnv = deps.readEnvFile(path.join(root, READ_ONLY_TEST_ENV_FILE));
  if (readOnlyEnv === undefined) throw new SchemaDiffError("READ_ONLY_ENV_MISSING", `${READ_ONLY_TEST_ENV_FILE} was not found.`);
  // katana_test_ro 以外（katana_test_user・開発用DB・ほかのホスト・クエリ付き）の URL は、ここで拒否される
  const readOnlyTarget = guard(readOnlyEnv[TEST_DB_RO_URL_KEY], {}, "READ_ONLY_TARGET_REJECTED", true);
  let readOnly: { databaseUrl: string; password: string };
  try {
    readOnly = assertReadOnlyTestDatabaseCredentials(readOnlyEnv, { databaseUrl: appUrl, ...passwords });
  } catch (error) {
    if (error instanceof ReadOnlyTestDatabaseCredentialsError) {
      throw new SchemaDiffError("READ_ONLY_CREDENTIALS_REJECTED", `the credentials in ${READ_ONLY_TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const developmentPassword = (() => {
    try {
      return developmentDatabaseUrl ? new URL(developmentDatabaseUrl).password : "";
    } catch {
      return "";
    }
  })();
  const secrets = [appUrl, passwords.appPassword, passwords.adminPassword, readOnly.databaseUrl, readOnly.password, developmentDatabaseUrl ?? "", developmentPassword].filter((s) => s !== "");
  const appCheck: CheckInput = { databaseUrl: appUrl, developmentDatabaseUrl };
  const roCheck: CheckInput = { databaseUrl: readOnly.databaseUrl, developmentDatabaseUrl };

  const requiredPaths = [SCHEMA_DIFF_BINARY_SHA256.cli.file, SCHEMA_DIFF_BINARY_SHA256.engine.file, SCHEMA_DIFF_CONFIG_FILE, SCHEMA_DIFF_SCHEMA_FILE, path.join("prisma", "migrations")];
  for (const relative of requiredPaths) {
    if (!deps.pathExists(path.join(root, relative))) throw new SchemaDiffError("REQUIRED_FILE_MISSING", `${relative} was not found. ${BEFORE_NOTE}`);
  }
  const verifyBinaries = () => assertSchemaDiffBinaries({ root, platform: deps.platform, arch: deps.arch, readBinary: deps.readBinary });
  verifyBinaries();

  let expectation: CatalogAuditExpectation;
  try {
    expectation = deps.loadExpectation();
  } catch (error) {
    throw new SchemaDiffError("EXPECTATION_INVALID", `the expectation could not be built from the repository files (${codeOf(error)}).`);
  }
  if (expectation.inventory.migrations.length !== EXPECTED_SCHEMA_DIFF_MIGRATION_COUNT) {
    throw new SchemaDiffError("MIGRATION_COUNT_MISMATCH", `expected ${EXPECTED_SCHEMA_DIFF_MIGRATION_COUNT} local migrations, found ${expectation.inventory.migrations.length}.`);
  }
  const tables = expectedReadOnlyRoleTables(expectation);

  // 子プロセスの環境変数（URL は入れず、SHA-256 だけ）。最終的な値で、名前・固定の値・秘密の値の有無・PG*・DOTENV_* をもう一度検証する
  const { childEnv } = buildSchemaDiffEnv(deps.parentEnv, readOnly.databaseUrl);
  const envViolations = schemaDiffEnvViolations(childEnv, readOnly.databaseUrl, secrets);
  if (envViolations.length > 0) throw new SchemaDiffError("CHILD_ENV_REJECTED", `the child environment was rejected (${envViolations.join("; ")}). ${BEFORE_NOTE}`);
  guard(readOnly.databaseUrl, childEnv, "CHILD_ENV_REJECTED", true);

  const expected = buildSchemaDiffCommand({ root, execPath: deps.execPath });
  const command = (deps.buildCommand ?? buildSchemaDiffCommand)({ root, execPath: deps.execPath });
  assertSchemaDiffCommand(command, expected);
  const options = buildSchemaDiffSpawnOptions(root, childEnv);

  const where = `${appTarget.host}:${appTarget.port}/${appTarget.database}`;
  const gateEnabled = deps.access.mode === "enabled-ro-schema-diff";
  if (mode === "dry-run") {
    const shown = command.args.map((arg) => (path.isAbsolute(arg) ? path.relative(root, arg) : arg));
    deps.log(
      [
        "[schemaDiff] dry run (--live was not given): Docker was not read, no database connection was made and the Prisma CLI was not started.",
        `test database: ${where}; application role ${appTarget.user} and read-only role ${readOnlyTarget.user} verified (passwords hidden)`,
        `pinned SHA-256 verified: ${SCHEMA_DIFF_BINARY_SHA256.cli.file}, ${SCHEMA_DIFF_BINARY_SHA256.engine.file}`,
        `planned command: node ${shown.join(" ")}  (cwd: katana-web; new process group; timeout ${options.timeoutMs} ms)`,
        `child environment: ${Object.keys(childEnv).sort().join(", ")} (values not shown; the URL itself is not included)`,
        `checks: D1/F1/FP1/A1/R1/D2 before, and D3/F2/FP2/R2 after the Prisma CLI regardless of its result (${tables.length} tables expected for ${readOnlyTarget.user}).`,
        `schema diff gate: ${gateEnabled ? "enabled" : "disabled in this build (--live stops with SCHEMA_DIFF_LIVE_DISABLED before reading Docker or connecting)"}`,
        `residual risk (accepted, not resolved): the Prisma CLI passes the ${readOnlyTarget.user} URL including its password to the schema engine as a process argument.`,
        ...SCHEMA_DIFF_SCOPE_NOTE.map((line) => `scope: ${line}`),
      ].join("\n"),
    );
    return { mode: "dry-run" };
  }

  // ---- ここからは --live だけ。固定のゲートが無効なら、Docker・DB・Prisma CLI に触れずに止まる ----
  if (!gateEnabled) {
    throw new SchemaDiffError("SCHEMA_DIFF_LIVE_DISABLED", "live schema diff is disabled in this build; refusing to read Docker, connect to the test database or start the Prisma CLI.");
  }

  // CLI の起動の前の中断：各段階の後で確かめ、CLI を起動せずに止める
  const throwIfInterrupted = () => {
    const signal = deps.interrupts.received();
    if (signal !== undefined) throw new SchemaDiffError("INTERRUPTED", `interrupted by ${signal}. ${BEFORE_NOTE}`);
  };
  throwIfInterrupted();
  let prepared: { docker1: Awaited<ReturnType<ReadDockerIdentity>>; server1: TestDatabaseInspection["server"]; migrations1: readonly string[]; expectedServer: PinnedServerExpectation; fp1: CatalogFingerprint };
  try {
    prepared = await prepareBeforeCli();
  } catch (error) {
    // 中断で実行中の段階（Docker のコマンド・DB の接続）が失敗したときも、中断として扱う
    throwIfInterrupted();
    throw error;
  }
  throwIfInterrupted();
  const { docker1, server1, migrations1, expectedServer, fp1 } = prepared;

  async function prepareBeforeCli() {

    const readDocker = async (label: "D1" | "D2") => {
      try {
        return await deps.readDockerIdentity({ root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile });
      } catch (error) {
        throw new SchemaDiffError("DOCKER_IDENTITY_FAILED", `the docker identity check ${label} failed (${codeOf(error)}). ${BEFORE_NOTE}`);
      }
    };

    // D1 → F1（本人確認・状態 C・migration・識別情報・D1 との整合）
    const docker1 = await readDocker("D1");
    throwIfInterrupted();
    let f1: TestDatabaseInspection;
    try {
      f1 = await deps.inspectDatabase(appCheck);
    } catch (error) {
      throw new SchemaDiffError("STATE_CHECK_FAILED", `the database check F1 failed (${codeOf(error)}). ${BEFORE_NOTE}`);
    }
    const server1 = f1.server;
    const mismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
    if (mismatches.length > 0) throw new SchemaDiffError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${mismatches.join(", ")}). ${BEFORE_NOTE}`);
    if (f1.state.state !== "C") throw new SchemaDiffError("DATABASE_STATE_NOT_C", `the test database is in state ${f1.state.state}, not C. ${BEFORE_NOTE}`);
    const migrations1 = f1.state.migrations;
    if (!sameNames(migrations1, expectation.inventory.migrations)) {
      throw new SchemaDiffError("MIGRATION_LIST_MISMATCH", `the applied migrations do not match the local migrations. ${BEFORE_NOTE}`);
    }
    const expectedServer: PinnedServerExpectation = { docker: docker1, server: server1 };
    throwIfInterrupted();

    // FP1（カタログの監査が passed・18区分。katana_test_ro が作成後の期待値どおり。今回読んだ値を期待値にはしない）
    let audit1: CatalogDefinitionAuditResult;
    try {
      audit1 = await deps.runAudit({ ...appCheck, expectation, expectedServer });
    } catch (error) {
      throw new SchemaDiffError("CATALOG_CHECK_FAILED", `the catalog check FP1 failed (${codeOf(error)}). ${BEFORE_NOTE}`);
    }
    const fp1Problem = fingerprintProblem(audit1, "FP1");
    if (fp1Problem !== undefined) throw new SchemaDiffError("CATALOG_CHECK_FAILED", `${fp1Problem}. ${BEFORE_NOTE}`);
    const fp1: CatalogFingerprint = audit1.fingerprint;
    if (!readOnlyRoleExistsIn(fp1)) throw new SchemaDiffError("ROLE_NOT_CREATED", `${readOnlyTarget.user} does not exist. ${BEFORE_NOTE}`);
    const catalogViolations = createdCatalogViolations(fp1, expectation, tables);
    if (catalogViolations.length > 0) {
      throw new SchemaDiffError("CATALOG_STATE_MISMATCH", `the catalog is not in the expected state (${catalogViolations.join("; ")}). ${BEFORE_NOTE}`);
    }
    throwIfInterrupted();

    // A1（DB・スキーマの ACL と PUBLIC の実効権限が、作成後の期待値どおり）
    let a1: PreChangeAclObservation;
    try {
      a1 = await deps.checkAcl({ ...appCheck, expectedServer });
    } catch (error) {
      throw new SchemaDiffError("ACL_CHECK_FAILED", `the ACL check A1 failed (${codeOf(error)}). ${BEFORE_NOTE}`);
    }
    const aclViolations = createdAclViolations(a1);
    if (aclViolations.length > 0) throw new SchemaDiffError("ACL_MISMATCH", `the ACLs are not the expected ones (${aclViolations.join(", ")}). ${BEFORE_NOTE}`);
    throwIfInterrupted();

    // R1（katana_test_ro 本人の読み取り専用の接続。SELECT だけ・書き込み・所有・余分な権限がないこと。接続・認証の失敗は成功にしない）
    let r1: ReturnType<typeof classifyReadOnlyRoleFull>;
    try {
      r1 = classifyReadOnlyRoleFull(await deps.checkReadOnlyRole({ ...roCheck, expectedServer }), tables);
    } catch (error) {
      throw new SchemaDiffError("READ_ONLY_ROLE_CHECK_FAILED", `the read-only role check R1 failed (${codeOf(error)}). ${BEFORE_NOTE}`);
    }
    if (!r1.passed) throw new SchemaDiffError("READ_ONLY_NOT_ENFORCED", `the read-only role is not limited to SELECT (${r1.findings.join("; ")}). ${BEFORE_NOTE}`);
    throwIfInterrupted();

    // D2（D1 と一致）
    const changedBefore = dockerIdentityChanges(docker1, await readDocker("D2"));
    if (changedBefore.length > 0) throw new SchemaDiffError("DOCKER_IDENTITY_MISMATCH", `the test database container changed (${changedBefore.join(", ")}). ${BEFORE_NOTE}`);
    return { docker1, server1, migrations1, expectedServer, fp1 };
  }

  // 起動の直前に、CLI・engine の SHA-256 をもう一度照合する（照合と起動の間の差し替えは防げない。TOCTOU）
  verifyBinaries();
  throwIfInterrupted();

  let result: SchemaDiffProcessResult;
  let processGroup: SchemaDiffCleanupState;
  try {
    result = await deps.spawnCapture(command.command, command.args, options, deps.interrupts);
    processGroup = result.kind === "spawn-error" ? "not-started" : result.processGroup;
  } catch (error) {
    // spawnCapture は reject しない設計。reject されたら、起動したかどうかが分からないので、停止を確かめられなかったものとして扱う
    result = { kind: "spawn-error", errorCode: codeOf(error) };
    processGroup = "not-confirmed";
  }
  const cli = classifySchemaDiffResult(result, secrets);

  // ---- 事後の検査（CLI の結果にかかわらず、すべて試す。1つが失敗しても残りを試す） ----
  const postChecks: PostCheckResult[] = [];
  const attempt = async (label: PostCheckLabel, check: () => Promise<string[]>) => {
    try {
      const problems = await check();
      postChecks.push({ label, passed: problems.length === 0, detail: problems.length === 0 ? "passed" : problems.join("; ") });
    } catch (error) {
      postChecks.push({ label, passed: false, detail: `the check failed (${codeOf(error)})` });
    }
  };
  await attempt("D3", async () => dockerIdentityChanges(docker1, await deps.readDockerIdentity({ root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile })));
  await attempt("F2", async () => {
    const f2 = await deps.inspectDatabase(appCheck);
    const problems = serverIdentityChanges(server1, f2.server);
    if (f2.state.state !== "C") problems.push(`state ${f2.state.state}, not C`);
    else if (!sameNames(f2.state.migrations, migrations1)) problems.push("the applied migrations changed");
    return problems;
  });
  await attempt("FP2", async () => {
    const audit2 = await deps.runAudit({ ...appCheck, expectation, expectedServer });
    const fp2Problem = fingerprintProblem(audit2, "FP2");
    if (fp2Problem !== undefined) return [fp2Problem];
    try {
      assertCatalogFingerprintUnchanged(fp1, audit2.fingerprint);
    } catch (error) {
      return [`the catalog changed from FP1 (${codeOf(error)})`];
    }
    return [];
  });
  await attempt("R2", async () => [...classifyReadOnlyRoleFull(await deps.checkReadOnlyRole({ ...roCheck, expectedServer }), tables).findings]);

  // 事後の検査の間に受けた中断も含める（CLI が正常に終わった後の中断も、no-diff・diff にしない）
  const interruptedBy = deps.interrupts.received();
  const { verdict, exitCode } = decideSchemaDiffVerdict(cli, postChecks, { processGroup, interruptedBy });
  const lines = [
    `[schemaDiff] ${where} as ${readOnlyTarget.user} (password hidden): Prisma CLI result ${cli.outcome}; verdict ${verdict} (exit code ${exitCode}).`,
    `checks D1/F1/FP1/A1/R1/D2 passed before the Prisma CLI; after: ${postChecks.map((c) => `${c.label} ${c.passed ? "passed" : `FAILED (${c.detail})`}`).join(", ")}.`,
  ];
  if (interruptedBy !== undefined) lines.push(`interrupted by ${interruptedBy}: the result is not "no difference" or "difference".`);
  if (processGroup === "not-confirmed") {
    lines.push("the Prisma CLI process group could not be confirmed as stopped; check that no node or schema-engine process of this run remains.");
  }
  if (verdict === "post-check-failed" || verdict === "cleanup-failed" || verdict === "interrupted") lines.push(AFTER_NOTE);
  if (cli.outcome === "diff") lines.push("differences (redacted; nothing was changed automatically):", cli.summary);
  if (cli.outcome === "cli-error" || cli.outcome === "unexpected-exit" || cli.outcome === "timeout" || cli.outcome === "interrupted") {
    lines.push("Prisma CLI output (redacted):", cli.output);
  }
  if (cli.outcome === "spawn-failed") lines.push(`the Prisma CLI could not be started (${cli.errorCode}).`);
  if (cli.outcome === "signal") lines.push(`the Prisma CLI was ended by ${cli.signal}.`);
  lines.push(...SCHEMA_DIFF_SCOPE_NOTE.map((line) => `scope: ${line}`));
  lines.push(`residual risk (accepted, not resolved): the ${readOnlyTarget.user} URL including its password was passed to the schema engine as a process argument; this result is a snapshot of this run.`);
  deps.log(lines.join("\n"));
  return { mode: "live", verdict, exitCode, cli, postChecks, processGroup, interruptedBy };
}
