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
  assertMigrationChecksums,
  type LocalMigrationChecksum,
  MigrationChecksumError,
  type MigrationChecksumComparison,
} from "./migrationChecksum.ts";
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
 * migration の checksum の照合だけを行う、読み取り専用の実行経路（Step 3-12B-5C-1。scripts/testdb-checksums.mts の本体）。
 *
 *   npm run testdb:checksums               … 予行。事前の検証と、ローカルの migration.sql の checksum の計算だけ（Docker・DB に触れない）
 *   npm run testdb:checksums -- --verify   … 実DBでの照合の意思表示。専用の固定のゲート（checksumDatabase）が有効なときだけ、
 *                                            D1 → F1 → D2 → checksum の照合 → F2 → D3 の順で照合する。
 *                                            スクリプトのゲートは固定の CHECKSUM_DATABASE_DISABLED なので、今は Docker・DB に触れる前に止まる。
 *
 * migration を適用する経路は持たない: Prisma CLI・子プロセスを起動せず、migration 用の LIVE_DATABASE_DISABLED・schemaDiff の
 * SCHEMA_DIFF_DISABLED も参照しない（別の型・別の値のゲート）。引数は「なし」か `--verify` の1つだけで、`--apply` などは拒否する。
 * ゲートは引数・環境変数では変えられない（スクリプトに固定の値として書く）。
 *
 * 安全検査は既存の部品を使い、ここで作り直さない:
 * - 接続先・パスワード・親の PG*・DOTENV_*：lib/db/testDatabaseGuard.ts（assertTestDatabaseTarget・assertTestDatabaseCredentials）
 * - D1・D2・D3：lib/testing/testDbDocker.ts の readTestDbDockerIdentity（Docker context・Compose・コンテナ・volume の識別。読み取りだけ）
 * - F1・F2：lib/testing/testDbState.ts の inspectTestDatabase（BEGIN READ ONLY・transaction_read_only=on・search_path=pg_catalog・
 *   本人確認4項目（DB名・current_user・session_user・DBのコメント）・権限・サーバーの識別情報・状態 A・B・C。SELECT・SHOW と ROLLBACK だけ）
 * - checksum：lib/testing/migrationChecksum.ts の inspectMigrationChecksums（同じ読み取り専用のトランザクション・本人確認の後に
 *   `_prisma_migrations` を SELECT し、ローカルの SHA-256 と完全一致で照合する）。Step 3-12B-5C-2 から、D1・F1 の識別情報を渡し、
 *   同じ接続・同じトランザクションの中で、履歴を読む前にサーバーの識別情報（IP・ポート・起動時刻）を照合する（pinnedServerMismatches）
 * - 照合：lib/testing/testDbIdentity.ts（PostgreSQL と Docker の識別情報の整合、前後の一致）
 *
 * どれか1つでも失敗したら、検証は失敗（例外）。F2・D3 の不一致・失敗は、checksum が一致していても成功と扱わない。
 * F1・checksum・F2 はそれぞれ別の接続（接続ごとに BEGIN READ ONLY → ROLLBACK → 接続の解放）。checksum の接続は、履歴を読む前に
 * D1・F1 と同じサーバーであることを確かめる。読んだ時点の照合なので、それ以外の入れ替わりは F2・D3 で事後に検出する（TOCTOU）。
 * 表示・例外のメッセージには、接続URL・パスワード・checksum の値を含めない（コード・migration の名前・件数だけ）。
 */

/**
 * 期待する migration の件数（Step 3-12B-3 でテストDBに適用した8件）。prisma/migrations の件数がこれと違えば、照合の前に止める。
 * migration を追加したときは、この値の更新も承認の対象にする（件数の変化を見落とさないため）。
 */
export const EXPECTED_MIGRATION_COUNT = 8;
const REQUIRED_PATHS = [path.join("prisma", "schema.prisma"), path.join("prisma", "migrations")];

export type TestDbChecksumsMode = "dry-run" | "verify";

export type TestDbChecksumsErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "REQUIRED_FILE_MISSING"
  | "LOCAL_MIGRATIONS_INVALID"
  | "MIGRATION_COUNT_MISMATCH"
  | "CHECKSUM_LIVE_DISABLED"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "DATABASE_STATE_NOT_C"
  | "MIGRATION_LIST_MISMATCH"
  | "CHECKSUM_CHECK_FAILED"
  | "CHECKSUM_CONNECTION_IDENTITY_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "POST_CHECK_FAILED"
  | "POST_IDENTITY_MISMATCH"
  | "POST_STATE_MISMATCH";

export class TestDbChecksumsError extends Error {
  readonly code: TestDbChecksumsErrorCode;

  constructor(code: TestDbChecksumsErrorCode, detail: string) {
    super(`[testdb-checksums] ${code}: ${detail}`);
    this.name = "TestDbChecksumsError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
type CheckInput = { databaseUrl: string; developmentDatabaseUrl: string | undefined };

/** checksum の照合用の実DBへの接続の許可（固定のゲート）。migration 用・schemaDiff 用とは別の型・別の値で、共有しない */
export type ChecksumDatabaseAccess = { readonly mode: "disabled" } | { readonly mode: "enabled-read-only" };
export const CHECKSUM_DATABASE_DISABLED: ChecksumDatabaseAccess = Object.freeze({ mode: "disabled" });

export type TestDbChecksumsDeps = {
  root: string;
  /** process.argv.slice(2) */
  argv: readonly string[];
  /** process.execArgv */
  execArgv: readonly string[];
  parentEnv: EnvSource;
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  /** ローカルの migration.sql の checksum（readLocalMigrationChecksums。ファイルを読むだけ） */
  readLocalChecksums: () => LocalMigrationChecksum[];
  /** 実DBへの接続の許可（固定のゲート）。`--verify` のときだけ、事前の検証の後で確かめる */
  checksumDatabase: ChecksumDatabaseAccess;
  /** D1・D2・D3（`--verify` で、ゲートが有効なときだけ呼ぶ） */
  readDockerIdentity: ReadDockerIdentity;
  /** F1・F2（同上） */
  inspectDatabase: InspectDatabase;
  /** checksum の照合（inspectMigrationChecksums。同上）。expectedServer は D1・F1 の識別情報で、同じ接続の中で照合する */
  inspectChecksums: (input: CheckInput & { expectedServer: PinnedServerExpectation }) => Promise<MigrationChecksumComparison>;
  log: (text: string) => void;
};

/** 引数は「なし」（予行）か `--verify` の1つだけ。それ以外（`--apply` を含む）は、何にも触れる前に止める */
export function parseTestDbChecksumsArgs(args: readonly string[]): TestDbChecksumsMode {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--verify") return "verify";
  throw new TestDbChecksumsError("ARGUMENTS_INVALID", "the only accepted argument is --verify (or no argument for a dry run).");
}

function guardTarget(databaseUrl: string | undefined, env: EnvSource, developmentDatabaseUrl: string | undefined, code: "TARGET_REJECTED" | "UNSAFE_PARENT_ENV"): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new TestDbChecksumsError(
        code,
        code === "TARGET_REJECTED" ? `the test database target was rejected (${error.code}).` : `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.`,
      );
    }
    throw error;
  }
}

/** エラーから、表示してよいコードだけを取り出す（メッセージ・接続URLは捨てる） */
function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError || error instanceof MigrationChecksumError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown";
}

const AFTER_NOTE = "This was detected after the checksum check, so the checksum result is not trusted. Nothing was changed, reset or repaired.";

async function readDocker(deps: TestDbChecksumsDeps, label: "D1" | "D2" | "D3") {
  try {
    return await deps.readDockerIdentity({ root: deps.root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile });
  } catch (error) {
    throw new TestDbChecksumsError("DOCKER_IDENTITY_FAILED", `the docker identity check ${label} failed (${codeOf(error)}).${label === "D3" ? ` ${AFTER_NOTE}` : ""}`);
  }
}

async function inspect(deps: TestDbChecksumsDeps, input: CheckInput, code: "STATE_CHECK_FAILED" | "POST_CHECK_FAILED"): Promise<TestDatabaseInspection> {
  try {
    return await deps.inspectDatabase(input);
  } catch (error) {
    throw new TestDbChecksumsError(code, `the database check ${code === "STATE_CHECK_FAILED" ? "F1" : "F2"} failed (${codeOf(error)}).${code === "POST_CHECK_FAILED" ? ` ${AFTER_NOTE}` : ""}`);
  }
}

const sameNames = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((name, i) => name === [...b].sort()[i]);

/** 手順どおりに検証する。成功なら0を返し、どれか1つでも失敗したら TestDbChecksumsError を投げる */
export async function runTestDbChecksums(deps: TestDbChecksumsDeps): Promise<number> {
  const { root } = deps;
  const mode = parseTestDbChecksumsArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new TestDbChecksumsError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new TestDbChecksumsError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the checksum check.");
  }

  // 事前の検証（.env.test・開発用DBとの比較・パスワード・親の PG*・DOTENV_*。pg はこのプロセスで接続し、PG* を読むため）
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new TestDbChecksumsError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentDatabaseUrl = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE))?.DATABASE_URL;
  const target = guardTarget(testEnv.DATABASE_URL, {}, developmentDatabaseUrl, "TARGET_REJECTED");
  try {
    assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new TestDbChecksumsError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const databaseUrl = testEnv.DATABASE_URL as string;
  guardTarget(databaseUrl, deps.parentEnv, developmentDatabaseUrl, "UNSAFE_PARENT_ENV");
  const checkInput: CheckInput = { databaseUrl, developmentDatabaseUrl };

  for (const relative of REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(root, relative))) throw new TestDbChecksumsError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }
  let local: LocalMigrationChecksum[];
  try {
    local = deps.readLocalChecksums();
  } catch (error) {
    throw new TestDbChecksumsError("LOCAL_MIGRATIONS_INVALID", `the local migrations could not be read (${codeOf(error)}).`);
  }
  if (local.length !== EXPECTED_MIGRATION_COUNT) {
    throw new TestDbChecksumsError("MIGRATION_COUNT_MISMATCH", `expected ${EXPECTED_MIGRATION_COUNT} local migrations, found ${local.length}.`);
  }
  const localNames = local.map((m) => m.name);
  const where = `${target.host}:${target.port}/${target.database} as ${target.user} (password hidden)`;

  if (mode === "dry-run") {
    deps.log(
      [
        "[testdb-checksums] dry run (--verify was not given): Docker was not read and no database connection was made.",
        `connection target: verified ${where}`,
        `local migrations: ${local.length} (checksums computed; values not shown)`,
        ...localNames.map((name) => `  ${name}`),
        `live checksum verification (--verify): ${deps.checksumDatabase.mode === "enabled-read-only" ? "enabled" : "disabled in this build (stops with CHECKSUM_LIVE_DISABLED before reading Docker or connecting)"}`,
        "this command never applies migrations and never starts the Prisma CLI.",
      ].join("\n"),
    );
    return 0;
  }

  // ここからは --verify だけ。固定のゲートが無効なら、Docker・DB に触れずに止まる
  if (deps.checksumDatabase.mode !== "enabled-read-only") {
    throw new TestDbChecksumsError("CHECKSUM_LIVE_DISABLED", "live checksum verification is disabled in this build; refusing to read Docker or connect to the test database.");
  }

  // D1 → F1（本人確認・状態 C・識別情報・D1 との整合・migration の一覧）
  const docker1 = await readDocker(deps, "D1");
  const { state, server: server1 } = await inspect(deps, checkInput, "STATE_CHECK_FAILED");
  const mismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
  if (mismatches.length > 0) {
    throw new TestDbChecksumsError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${mismatches.join(", ")}).`);
  }
  if (state.state !== "C") throw new TestDbChecksumsError("DATABASE_STATE_NOT_C", `the test database is in state ${state.state}, not C.`);
  if (state.migrations.length !== EXPECTED_MIGRATION_COUNT || !sameNames(state.migrations, localNames)) {
    throw new TestDbChecksumsError("MIGRATION_LIST_MISMATCH", "the applied migrations do not match the local migrations.");
  }

  // D2（D1 と一致）
  const changedBefore = dockerIdentityChanges(docker1, await readDocker(deps, "D2"));
  if (changedBefore.length > 0) {
    throw new TestDbChecksumsError("DOCKER_IDENTITY_MISMATCH", `the test database container changed (${changedBefore.join(", ")}); the checksum check was not run.`);
  }

  // checksum の照合（失敗・不一致は記録し、F2・D3 の後で判定する）
  let comparison: MigrationChecksumComparison | undefined;
  let checksumError: unknown;
  try {
    comparison = await deps.inspectChecksums({ ...checkInput, expectedServer: { docker: docker1, server: server1 } });
  } catch (error) {
    checksumError = error;
  }

  // F2（F1 と一致・状態 C）→ D3（D1 と一致）。どちらかが失敗したら、checksum の結果に関わらず失敗
  const { state: after, server: server2 } = await inspect(deps, checkInput, "POST_CHECK_FAILED");
  const serverChanges = serverIdentityChanges(server1, server2);
  if (serverChanges.length > 0) {
    throw new TestDbChecksumsError("POST_IDENTITY_MISMATCH", `the database server changed during the check (${serverChanges.join(", ")}). ${AFTER_NOTE}`);
  }
  const changedAfter = dockerIdentityChanges(docker1, await readDocker(deps, "D3"));
  if (changedAfter.length > 0) {
    throw new TestDbChecksumsError("POST_IDENTITY_MISMATCH", `the test database container changed during the check (${changedAfter.join(", ")}). ${AFTER_NOTE}`);
  }
  if (after.state !== "C") throw new TestDbChecksumsError("POST_STATE_MISMATCH", `after the check, the test database is in state ${after.state}, not C. ${AFTER_NOTE}`);

  // 最終結果
  if (comparison === undefined) {
    if (checksumError instanceof MigrationChecksumError && checksumError.code === "SERVER_IDENTITY_MISMATCH") {
      // 項目名だけを含むメッセージ（値は含まない）
      throw new TestDbChecksumsError("CHECKSUM_CONNECTION_IDENTITY_MISMATCH", `${checksumError.message.replace(/^\[migrationChecksum\] [A-Z_]+: /, "")} The migration history was not read. Nothing was changed.`);
    }
    throw new TestDbChecksumsError("CHECKSUM_CHECK_FAILED", `the checksum check failed (${codeOf(checksumError)}). Nothing was changed.`);
  }
  try {
    assertMigrationChecksums(comparison);
  } catch (error) {
    // 名前・件数だけを含むメッセージ（checksum の値は含まない）
    const detail = error instanceof MigrationChecksumError ? error.message.replace(/^\[migrationChecksum\] [A-Z_]+: /, "") : "unknown";
    throw new TestDbChecksumsError("CHECKSUM_MISMATCH", detail);
  }
  deps.log(
    [
      `[testdb-checksums] verified ${where}: all ${local.length} migration checksums match exactly (read-only; nothing was changed).`,
      "identity checks D1/F1/D2/F2/D3 passed; state C before and after.",
    ].join("\n"),
  );
  return 0;
}
