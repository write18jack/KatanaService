import path from "node:path";
import {
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck.ts";
import { DEVELOPMENT_ENV_FILE, TEST_ENV_FILE } from "./integrationEnv.ts";
import {
  CATALOG_FINGERPRINT_SECTIONS,
  CatalogAuditError,
  type CatalogAuditExpectation,
  type CatalogDefinitionAuditResult,
} from "./testDbCatalogAudit.ts";
import {
  dockerIdentityChanges,
  type PinnedServerExpectation,
  serverDockerMismatches,
  serverIdentityChanges,
  serverIdentityMismatches,
} from "./testDbIdentity.ts";
import type { InspectDatabase, ReadDockerIdentity } from "./testDbMigrate.ts";
import type { TestDatabaseInspection } from "./testDbState.ts";

/**
 * テストDBのカタログの定義の監査だけを行う、読み取り専用の実行経路（Step 3-12B-5C-5C。scripts/testdb-catalog.mts の本体）。
 *
 *   npm run testdb:catalog               … 予行。事前の検証と、リポジトリのファイルからの期待値の構築だけ（Docker・DB に触れない）
 *   npm run testdb:catalog -- --verify   … 実DBでの監査の意思表示。専用の固定のゲート（catalogDatabase）が有効なときだけ、
 *                                          D1 → F1 → D2 → カタログの監査 → F2 → D3 の順で照合する。
 *                                          スクリプトのゲートは固定の CATALOG_AUDIT_DATABASE_DISABLED なので、今は Docker・DB に触れる前に止まる。
 *
 * 接続するロールは既存の katana_test_user（.env.test の DATABASE_URL）だけ。行うのは、lib/testing/testDbCatalogAudit.ts の
 * runCatalogDefinitionAudit（DB 固有の定義・enum の値と順序の監査と、カタログの fingerprint の取得）だけ。
 * **読み取り専用ロール（katana_test_ro）の権限・可視性の検査は行わない**（ロールは未作成）。この監査の成功は、
 * 将来の読み取り専用ロールの実効権限を証明しない。Prisma CLI・migration の適用・checksum の照合の経路は持たない。
 * 引数は「なし」か `--verify` の1つだけで、`--apply` などは拒否する。ゲートは引数・環境変数では変えられない（スクリプトに固定の値として書く）。
 *
 * 成功の条件（すべて）：F1・F2 とも状態 C（migration の履歴8件・テーブルが空。既存の判定）、Docker・PostgreSQL の識別情報が前後で一致、
 * 監査の接続のサーバーが D1・F1 と同じ、監査の結果が passed（failed・unverified は失敗）、fingerprint の取得、ROLLBACK・接続の解放。
 * F2・D3 が失敗したら、監査の結果が passed でも成功にしない。
 *
 * fingerprint：今回は1回だけ取得して、呼び出し側に返す（値・ハッシュは表示しない）。**1回の取得は前後の比較ではない。**
 * 将来、Prisma CLI（migrate diff）の前後を比べるときは、同じ実行の中で前後2回取得し、assertCatalogFingerprintUnchanged で
 * 一致を確かめることを必須とする。fingerprint の一致は「観測の間で定義が変わっていない」ことで、Prisma schema との一致ではない。
 *
 * 表示・例外のメッセージには、接続URL・パスワード・fingerprint のハッシュ・ロールの設定値を含めない（コード・名前・件数だけ）。
 */

/** 期待する migration の件数（lib/testing/testDbChecksums.ts の EXPECTED_MIGRATION_COUNT と同じ値。テストで一致を確かめる） */
export const EXPECTED_CATALOG_MIGRATION_COUNT = 8;
const REQUIRED_PATHS = [path.join("prisma", "schema.prisma"), path.join("prisma", "migrations")];

export type TestDbCatalogMode = "dry-run" | "verify";

export type TestDbCatalogErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "REQUIRED_FILE_MISSING"
  | "EXPECTATION_INVALID"
  | "EXPECTATION_UNSUPPORTED"
  | "MIGRATION_COUNT_MISMATCH"
  | "CATALOG_AUDIT_LIVE_DISABLED"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "DATABASE_STATE_NOT_C"
  | "MIGRATION_LIST_MISMATCH"
  | "CATALOG_AUDIT_CHECK_FAILED"
  | "CATALOG_AUDIT_CONNECTION_IDENTITY_MISMATCH"
  | "CATALOG_AUDIT_FAILED"
  | "CATALOG_AUDIT_UNVERIFIED"
  | "POST_CHECK_FAILED"
  | "POST_IDENTITY_MISMATCH"
  | "POST_STATE_MISMATCH";

export class TestDbCatalogError extends Error {
  readonly code: TestDbCatalogErrorCode;

  constructor(code: TestDbCatalogErrorCode, detail: string) {
    super(`[testdb-catalog] ${code}: ${detail}`);
    this.name = "TestDbCatalogError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
type CheckInput = { databaseUrl: string; developmentDatabaseUrl: string | undefined };

/** カタログの監査用の実DBへの接続の許可（固定のゲート）。migration 用・checksum 用・schemaDiff 用とは別の型・別の値で、共有しない */
export type CatalogAuditDatabaseAccess = { readonly mode: "disabled" } | { readonly mode: "enabled-read-only" };
export const CATALOG_AUDIT_DATABASE_DISABLED: CatalogAuditDatabaseAccess = Object.freeze({ mode: "disabled" });

export type TestDbCatalogDeps = {
  root: string;
  /** process.argv.slice(2) */
  argv: readonly string[];
  /** process.execArgv */
  execArgv: readonly string[];
  parentEnv: EnvSource;
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** リポジトリの schema.prisma・migrations から期待値を作る（loadCatalogAuditExpectation。ファイルを読むだけ） */
  loadExpectation: () => CatalogAuditExpectation;
  /** 実DBへの接続の許可（固定のゲート）。`--verify` のときだけ、事前の検証の後で確かめる */
  catalogDatabase: CatalogAuditDatabaseAccess;
  /** D1・D2・D3（`--verify` で、ゲートが有効なときだけ呼ぶ） */
  readDockerIdentity: ReadDockerIdentity;
  /** F1・F2（同上。katana_test_user の読み取り専用の接続） */
  inspectDatabase: InspectDatabase;
  /** カタログの監査（runCatalogDefinitionAudit。同上）。expectedServer は D1・F1 の識別情報で、監査の接続の中で照合する */
  runAudit: (input: CheckInput & { expectation: CatalogAuditExpectation; expectedServer: PinnedServerExpectation }) => Promise<CatalogDefinitionAuditResult>;
  log: (text: string) => void;
};

export type TestDbCatalogOutcome =
  | { readonly mode: "dry-run" }
  /** fingerprint は将来の前後の比較の基準として返す（表示しない） */
  | { readonly mode: "verify"; readonly result: CatalogDefinitionAuditResult };

/** 引数は「なし」（予行）か `--verify` の1つだけ。それ以外（`--apply`・未知の引数・併用）は、何にも触れる前に止める */
export function parseTestDbCatalogArgs(args: readonly string[]): TestDbCatalogMode {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--verify") return "verify";
  throw new TestDbCatalogError("ARGUMENTS_INVALID", "the only accepted argument is --verify (or no argument for a dry run).");
}

function guardTarget(databaseUrl: string | undefined, env: EnvSource, developmentDatabaseUrl: string | undefined, code: "TARGET_REJECTED" | "UNSAFE_PARENT_ENV"): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbCatalogError(
        code,
        code === "TARGET_REJECTED" ? `the test database target was rejected (${error.code}).` : `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.`,
      );
    }
    throw error;
  }
}

/** エラーから、表示してよいコードだけを取り出す（メッセージ・接続URLは捨てる） */
function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError || error instanceof CatalogAuditError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown";
}

const AFTER_NOTE = "This was detected after the catalog audit, so the audit result is not trusted. Nothing was changed, reset or repaired.";

async function readDocker(deps: TestDbCatalogDeps, label: "D1" | "D2" | "D3") {
  try {
    return await deps.readDockerIdentity({ root: deps.root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile });
  } catch (error) {
    throw new TestDbCatalogError("DOCKER_IDENTITY_FAILED", `the docker identity check ${label} failed (${codeOf(error)}).${label === "D3" ? ` ${AFTER_NOTE}` : ""}`);
  }
}

async function inspect(deps: TestDbCatalogDeps, input: CheckInput, code: "STATE_CHECK_FAILED" | "POST_CHECK_FAILED"): Promise<TestDatabaseInspection> {
  try {
    return await deps.inspectDatabase(input);
  } catch (error) {
    throw new TestDbCatalogError(code, `the database check ${code === "STATE_CHECK_FAILED" ? "F1" : "F2"} failed (${codeOf(error)}).${code === "POST_CHECK_FAILED" ? ` ${AFTER_NOTE}` : ""}`);
  }
}

const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((name, i) => name === [...b].sort()[i]);

/** CatalogAuditError のメッセージは、コード・分類・名前・件数だけで作られている。接頭辞だけを除く */
const auditDetail = (error: CatalogAuditError) => error.message.replace(/^\[catalogAudit\] [A-Z_]+: /, "");

/** 手順どおりに検証する。成功なら結果を返し、どれか1つでも失敗したら TestDbCatalogError を投げる */
export async function runTestDbCatalogAudit(deps: TestDbCatalogDeps): Promise<TestDbCatalogOutcome> {
  const { root } = deps;
  const mode = parseTestDbCatalogArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new TestDbCatalogError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbCatalogError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the catalog audit.");
  }

  // 事前の検証（.env.test・開発用DBとの比較・パスワード・親の PG*・DOTENV_*）
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new TestDbCatalogError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentDatabaseUrl = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE))?.DATABASE_URL;
  const target = guardTarget(testEnv.DATABASE_URL, {}, developmentDatabaseUrl, "TARGET_REJECTED");
  try {
    assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new TestDbCatalogError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const databaseUrl = testEnv.DATABASE_URL as string;
  guardTarget(databaseUrl, deps.parentEnv, developmentDatabaseUrl, "UNSAFE_PARENT_ENV");
  const checkInput: CheckInput = { databaseUrl, developmentDatabaseUrl };

  for (const relative of REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(root, relative))) throw new TestDbCatalogError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }

  // 期待値（リポジトリのファイルだけ。DB から独立）。確定できない項目があれば、監査は unverified にしかならないので、ここで止める
  let expectation: CatalogAuditExpectation;
  try {
    expectation = deps.loadExpectation();
  } catch (error) {
    throw new TestDbCatalogError("EXPECTATION_INVALID", `the expectation could not be built from the repository files (${codeOf(error)}).`);
  }
  const unsupported = [
    ...(expectation.enums.status === "unsupported" ? ["enum values and order"] : []),
    ...(expectation.dbSpecific.status === "unsupported" ? ["database-specific definitions"] : []),
  ];
  if (unsupported.length > 0) {
    throw new TestDbCatalogError("EXPECTATION_UNSUPPORTED", `the expected ${unsupported.join(" and ")} could not be established from the repository files; the audit would be unverified.`);
  }
  if (expectation.inventory.migrations.length !== EXPECTED_CATALOG_MIGRATION_COUNT) {
    throw new TestDbCatalogError("MIGRATION_COUNT_MISMATCH", `expected ${EXPECTED_CATALOG_MIGRATION_COUNT} local migrations, found ${expectation.inventory.migrations.length}.`);
  }
  const where = `${target.host}:${target.port}/${target.database} as ${target.user} (password hidden)`;
  const enumCount = expectation.enums.status === "supported" ? Object.keys(expectation.enums.enums).length : 0;

  if (mode === "dry-run") {
    deps.log(
      [
        "[testdb-catalog] dry run (--verify was not given): Docker was not read and no database connection was made.",
        `connection target: verified ${where}`,
        `expectation from the repository: ${expectation.inventory.tables.length} tables, ${enumCount} enums (values and order from the migrations), ` +
          `${expectation.inventory.migrations.length} migrations, no database-specific definitions expected`,
        `live catalog audit (--verify): ${deps.catalogDatabase.mode === "enabled-read-only" ? "enabled" : "disabled in this build (stops with CATALOG_AUDIT_LIVE_DISABLED before reading Docker or connecting)"}`,
        "this command never applies migrations, never starts the Prisma CLI, and does not check the read-only role (katana_test_ro).",
      ].join("\n"),
    );
    return { mode: "dry-run" };
  }

  // ここからは --verify だけ。固定のゲートが無効なら、Docker・DB に触れずに止まる
  if (deps.catalogDatabase.mode !== "enabled-read-only") {
    throw new TestDbCatalogError("CATALOG_AUDIT_LIVE_DISABLED", "live catalog audit is disabled in this build; refusing to read Docker or connect to the test database.");
  }

  // D1 → F1（本人確認・状態 C・識別情報・D1 との整合・migration の一覧）
  const docker1 = await readDocker(deps, "D1");
  const { state, server: server1 } = await inspect(deps, checkInput, "STATE_CHECK_FAILED");
  const mismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
  if (mismatches.length > 0) {
    throw new TestDbCatalogError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${mismatches.join(", ")}).`);
  }
  if (state.state !== "C") throw new TestDbCatalogError("DATABASE_STATE_NOT_C", `the test database is in state ${state.state}, not C.`);
  if (state.migrations.length !== EXPECTED_CATALOG_MIGRATION_COUNT || !sameNames(state.migrations, expectation.inventory.migrations)) {
    throw new TestDbCatalogError("MIGRATION_LIST_MISMATCH", "the applied migrations do not match the local migrations.");
  }

  // D2（D1 と一致）
  const changedBefore = dockerIdentityChanges(docker1, await readDocker(deps, "D2"));
  if (changedBefore.length > 0) {
    throw new TestDbCatalogError("DOCKER_IDENTITY_MISMATCH", `the test database container changed (${changedBefore.join(", ")}); the catalog audit was not run.`);
  }

  // カタログの監査（失敗は記録し、F2・D3 の後で判定する）
  let result: CatalogDefinitionAuditResult | undefined;
  let auditError: unknown;
  try {
    result = await deps.runAudit({ ...checkInput, expectation, expectedServer: { docker: docker1, server: server1 } });
  } catch (error) {
    auditError = error;
  }

  // F2（F1 と一致・状態 C）→ D3（D1 と一致）。どちらかが失敗したら、監査の結果に関わらず失敗
  const { state: after, server: server2 } = await inspect(deps, checkInput, "POST_CHECK_FAILED");
  const serverChanges = serverIdentityChanges(server1, server2);
  if (serverChanges.length > 0) {
    throw new TestDbCatalogError("POST_IDENTITY_MISMATCH", `the database server changed during the audit (${serverChanges.join(", ")}). ${AFTER_NOTE}`);
  }
  const changedAfter = dockerIdentityChanges(docker1, await readDocker(deps, "D3"));
  if (changedAfter.length > 0) {
    throw new TestDbCatalogError("POST_IDENTITY_MISMATCH", `the test database container changed during the audit (${changedAfter.join(", ")}). ${AFTER_NOTE}`);
  }
  if (after.state !== "C") throw new TestDbCatalogError("POST_STATE_MISMATCH", `after the audit, the test database is in state ${after.state}, not C. ${AFTER_NOTE}`);

  // 最終結果
  if (result === undefined) {
    if (auditError instanceof CatalogAuditError && auditError.code === "SERVER_IDENTITY_MISMATCH") {
      throw new TestDbCatalogError("CATALOG_AUDIT_CONNECTION_IDENTITY_MISMATCH", `${auditDetail(auditError)} Nothing was changed.`);
    }
    throw new TestDbCatalogError("CATALOG_AUDIT_CHECK_FAILED", `the catalog audit failed (${codeOf(auditError)}). Nothing was changed.`);
  }
  const summary = result.report.findings.map((f) => `${f.category}: ${f.items.join(", ")}`).join("; ");
  if (result.report.verdict === "failed") throw new TestDbCatalogError("CATALOG_AUDIT_FAILED", `the catalog definitions do not match the expectation (${summary}).`);
  if (result.report.verdict !== "passed") {
    throw new TestDbCatalogError("CATALOG_AUDIT_UNVERIFIED", `the catalog audit could not be verified (${summary || result.report.verdict}).`);
  }
  const sections = Object.keys(result.fingerprint.sections);
  if (sections.length !== Object.keys(CATALOG_FINGERPRINT_SECTIONS).length) {
    throw new TestDbCatalogError("CATALOG_AUDIT_CHECK_FAILED", "the catalog fingerprint is incomplete.");
  }
  deps.log(
    [
      `[testdb-catalog] verified ${where}: the catalog definition audit passed (read-only; nothing was changed).`,
      "identity checks D1/F1/D2/F2/D3 passed; state C before and after.",
      `catalog fingerprint: ${sections.length} sections captured (hash and values not shown). A single capture is not a before/after comparison.`,
      "this does not verify the read-only role (katana_test_ro) or that the database matches schema.prisma (Prisma migrate diff).",
    ].join("\n"),
  );
  return { mode: "verify", result };
}
