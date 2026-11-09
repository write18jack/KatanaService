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
import { dockerIdentityChanges, serverDockerMismatches, serverIdentityChanges, serverIdentityMismatches } from "./testDbIdentity.ts";
import {
  buildTestDbMigrateEnv,
  type InspectDatabase,
  PRISMA_CLI_ENTRY,
  PRISMA_CONFIG_FILE,
  type ReadDockerIdentity,
} from "./testDbMigrate.ts";
import type { TestDatabaseInspection, TestDatabasePrivileges } from "./testDbState.ts";

/**
 * Prisma schema と、テストDBの実際の定義の差分の検証（Step 3-12B-5B。完了条件2の一部）。
 *
 * **このモジュールは、どのスクリプトからも呼ばない。** 実DBでの実行は、承認を得た Step 3-12B-5C 以降で組み込む。
 * 固定のゲート（SCHEMA_DIFF_DISABLED）は migration 用の LIVE_DATABASE_DISABLED とは別の値で、共有しない。
 * 子プロセスの起動は引数（spawnCapture）で受け取るので、単体テストでは Prisma CLI を起動せず、DBにも接続しない。
 *
 * 固定のコマンド（任意の引数は受け付けない）:
 *   node node_modules/prisma/build/index.js migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code --config prisma.config.ts
 * パスは katana-web/ の絶対パスで渡す（testdb-migrate と同じ）。`--script`・`--output`・`--from-migrations`・`--to-migrations` は付けない
 * （`--from-/--to-migrations` を使わないので、shadow DB は不要）。
 *
 * Prisma 7.2.0 の仕様（node_modules/prisma/build/index.js を静的に確認。CLI は起動していない）:
 * - `--exit-code` があると、差分なし 0・エラー 1・差分あり 2（エンジンの結果の exitCode で process.exit）。
 * - `--from-config-datasource` は prisma.config.ts の datasource.url を使う。prisma.config.ts は KATANA_DB_TARGET=test のとき、
 *   lib/db/prismaCliGuard.ts で `.env.test` を検証し、プロセスの DATABASE_URL と一致した場合だけ、その URL を使う。
 * - CLI は schema engine（node_modules/@prisma/engines の native binary）を `--datasource <JSON>` 付きで起動し、
 *   **CLI のプロセスとは別に、エンジンが自分で DB に接続する**（親の環境変数から PWD を除いたものを引き継ぐ）。
 * - ヘルプには「read-only command」とあるが、エンジンの中の Rust のコードはインストールされておらず、確認できない。
 *   バイナリには pg_advisory_lock・CREATE SCHEMA IF NOT EXISTS・CREATE TABLE _prisma_migrations などの文字列もある。
 *   **コマンド名だけで書き込みが不可能とはみなさない。** DB の権限で読み取り専用を強制できるまで、ゲートを有効にしない。
 *
 * 実行順序（runSchemaDiffCheck。途中で失敗したら止まる。別の接続先は試さない・自動の修復はしない）:
 * 1. Node の起動オプションの拒否  2. `.env.test`・`.env` の読み込み  3. URL・パスワード・親の PG*・DOTENV_* の検証、
 * 子プロセスの環境変数の生成と再検証（testdb-migrate と同じ部品）  4. 必要なファイルの確認  5. 固定のコマンドの組み立てと照合
 * 6. ゲート（無効なら、Docker・DB・Prisma CLI に触れずに止まる）  7. D1  8. F1（本人確認・状態 C・識別情報・D1 との照合）
 * 9. 読み取り専用の権限の確認（今の katana_test_user は CREATE・DB の所有者なので、ここで必ず止まる）  10. D2（D1 と一致）
 * 11. Prisma CLI（migrate diff）  12. F2（F1 と一致・状態 C のまま）  13. D3（D1 と一致）  14. 終了コードの分類
 * D1・F1・権限・D2 の不一致は Prisma CLI の起動の前に止める（防止）。F2・D3 の不一致は事後の検出で、その場合は差分の結果を信用しない。
 * これは読んだ時点の照合で、CLI（エンジン）の新しい接続が同じDBに届くことを完全には保証しない（TOCTOU。入れ替わりは F2・D3 で事後に検出する）。
 *
 * 表示・例外のメッセージには、接続URL・パスワードを含めない。CLI の出力は redactSecrets で伏せてから返す。
 */

export const PRISMA_SCHEMA_FILE = path.join("prisma", "schema.prisma");
/** migrate diff の終了を待つ上限。超えたら呼び出し側（spawnCapture）が子プロセスを止め、timeout を返す */
export const SCHEMA_DIFF_TIMEOUT_MS = 120_000;
/** 返す CLI の出力の上限（文字数） */
export const SCHEMA_DIFF_MAX_OUTPUT = 8_000;
const HIDDEN = "(hidden)";

/**
 * 固定のコマンドに現れてはならない引数（変更系のサブコマンド・SQL の出力・ファイルへの書き込み・shadow DB を使う入力）。
 * 照合は完全一致の配列で行うので、これは念のための二重の確認。
 */
export const FORBIDDEN_SCHEMA_DIFF_ARGS: ReadonlySet<string> = new Set([
  "deploy",
  "dev",
  "reset",
  "resolve",
  "push",
  "pull",
  "execute",
  "seed",
  "db",
  "--script",
  "--output",
  "-o",
  "--from-migrations",
  "--to-migrations",
  "--to-config-datasource",
  "--from-empty",
  "--to-empty",
  "--shadow-database-url",
  "--from-url",
  "--to-url",
  "--schema",
  "--force",
  "--accept-data-loss",
]);

export type SchemaDiffErrorCode =
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "UNSAFE_PARENT_ENV"
  | "REQUIRED_FILE_MISSING"
  | "COMMAND_REJECTED"
  | "SCHEMA_DIFF_LIVE_DISABLED"
  | "DOCKER_IDENTITY_FAILED"
  | "DOCKER_IDENTITY_MISMATCH"
  | "STATE_CHECK_FAILED"
  | "SERVER_IDENTITY_MISMATCH"
  | "DATABASE_STATE_NOT_C"
  | "READ_ONLY_NOT_ENFORCED"
  | "POST_DIFF_CHECK_FAILED"
  | "POST_DIFF_IDENTITY_MISMATCH"
  | "POST_DIFF_STATE_MISMATCH";

export class SchemaDiffError extends Error {
  readonly code: SchemaDiffErrorCode;

  constructor(code: SchemaDiffErrorCode, detail: string) {
    super(`[schemaDiff] ${code}: ${detail}`);
    this.name = "SchemaDiffError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

// ---- 固定のコマンド ----

export type SchemaDiffSpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  /** 標準入力は渡さない。出力は伏せてから表示するため、受け取る */
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly timeoutMs: number;
};

export type SchemaDiffCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

/** 固定のコマンドを組み立てる（純粋関数。引数を追加する経路はない） */
export function buildSchemaDiffCommand(input: { root: string; execPath: string }): SchemaDiffCommand {
  const { root, execPath } = input;
  return Object.freeze({
    command: execPath,
    args: Object.freeze([
      path.join(root, PRISMA_CLI_ENTRY),
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      path.join(root, PRISMA_SCHEMA_FILE),
      "--exit-code",
      "--config",
      path.join(root, PRISMA_CONFIG_FILE),
    ]),
  });
}

/** 子プロセスの起動オプション（shell: false 固定） */
export function buildSchemaDiffSpawnOptions(root: string, childEnv: Readonly<Record<string, string>>): SchemaDiffSpawnOptions {
  return Object.freeze({ cwd: root, env: Object.freeze({ ...childEnv }), shell: false, stdio: Object.freeze(["ignore", "pipe", "pipe"] as const), timeoutMs: SCHEMA_DIFF_TIMEOUT_MS });
}

/** 固定のコマンドと完全に一致し、禁止された引数を含まないこと（違えば起動しない） */
export function assertSchemaDiffCommand(candidate: SchemaDiffCommand, expected: SchemaDiffCommand): void {
  const sameArgs = candidate.args.length === expected.args.length && candidate.args.every((arg, i) => arg === expected.args[i]);
  if (candidate.command !== expected.command || !sameArgs) {
    throw new SchemaDiffError("COMMAND_REJECTED", "the Prisma CLI command is not the fixed migrate diff command; the Prisma CLI was not started.");
  }
  if (candidate.args.some((arg) => FORBIDDEN_SCHEMA_DIFF_ARGS.has(arg) || /^--(script|output|shadow)/.test(arg))) {
    throw new SchemaDiffError("COMMAND_REJECTED", "the Prisma CLI command contains a forbidden argument; the Prisma CLI was not started.");
  }
}

// ---- 終了コードの分類 ----

/** spawnCapture の結果。exit：終了した（code か signal のどちらか）。spawn-error：起動できなかった。timeout：上限を超えて止めた */
export type SchemaDiffProcessResult =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "spawn-error"; readonly errorCode: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string };

/** no-diff だけが成功。diff（差分あり）と cli-error（実行エラー）は別に扱う */
export type SchemaDiffOutcome =
  | { readonly outcome: "no-diff" }
  | { readonly outcome: "diff"; readonly summary: string }
  | { readonly outcome: "cli-error"; readonly output: string }
  | { readonly outcome: "unexpected-exit"; readonly exitCode: number | null; readonly output: string }
  | { readonly outcome: "signal"; readonly signal: string }
  | { readonly outcome: "timeout"; readonly output: string }
  | { readonly outcome: "spawn-failed"; readonly errorCode: string };

/** 出力から接続URL・パスワードを伏せ、長さを制限する */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  // 先に、接続URL（知らないものを含む。認証情報を含み得る）のスキームから後ろを伏せ、その後で個別の値を伏せる
  let result = text.replace(/postgres(?:ql)?:\/\/[^\s"'`]*/gi, `postgresql://${HIDDEN}`);
  for (const secret of [...secrets].filter((s) => s !== "").sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(HIDDEN);
  }
  return result.length > SCHEMA_DIFF_MAX_OUTPUT ? `${result.slice(0, SCHEMA_DIFF_MAX_OUTPUT)}\n… (output truncated)` : result;
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_SIGNAL = /^SIG[A-Z0-9]+$/;

/** 終了コードを分類する（純粋関数）。0：差分なし、1：CLI のエラー、2：差分あり、それ以外：想定外 */
export function classifySchemaDiffResult(result: SchemaDiffProcessResult, secrets: readonly string[]): SchemaDiffOutcome {
  if (result.kind === "spawn-error") {
    return { outcome: "spawn-failed", errorCode: SAFE_ERROR_CODE.test(result.errorCode) ? result.errorCode : "unknown" };
  }
  const output = redactSecrets([result.stdout, result.stderr].filter((s) => s !== "").join("\n"), secrets);
  if (result.kind === "timeout") return { outcome: "timeout", output };
  if (result.signal !== null) return { outcome: "signal", signal: SAFE_SIGNAL.test(result.signal) ? result.signal : "unknown" };
  switch (result.code) {
    case 0:
      return { outcome: "no-diff" };
    case 1:
      return { outcome: "cli-error", output };
    case 2:
      return { outcome: "diff", summary: redactSecrets(result.stdout, secrets) };
    default:
      return { outcome: "unexpected-exit", exitCode: Number.isInteger(result.code) ? result.code : null, output };
  }
}

export function schemaDiffSucceeded(outcome: SchemaDiffOutcome): boolean {
  return outcome.outcome === "no-diff";
}

// ---- 接続先の検証と子プロセスの環境変数（testdb-migrate と同じ部品） ----

export type PreparedSchemaDiff = {
  target: TestDatabaseTarget;
  checkInput: { databaseUrl: string; developmentDatabaseUrl: string | undefined };
  childEnv: Record<string, string>;
  /** 出力から伏せる値（接続URL・パスワード） */
  secrets: string[];
};

function rejectTarget(databaseUrl: string | undefined, env: EnvSource, developmentDatabaseUrl: string | undefined, code: "TARGET_REJECTED" | "UNSAFE_PARENT_ENV"): TestDatabaseTarget {
  try {
    return assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl });
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) {
      throw new SchemaDiffError(code, code === "TARGET_REJECTED" ? `the test database target was rejected (${error.code}).` : `the environment of this process was rejected (${error.code}); unset PG* and DOTENV_* variables.`);
    }
    throw error;
  }
}

function passwordOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).password || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `.env.test` の接続先・パスワード、親の環境変数を検証し、子プロセスの環境変数を作る（DB・Docker には触れない）。
 * 開発用DB（`.env`）と同じ接続先、PG*・DOTENV_*・クエリ文字列付きのURLなどは assertTestDatabaseTarget が拒否する。
 */
export function prepareSchemaDiff(input: { testEnv: EnvSource; developmentEnv: EnvSource | undefined; parentEnv: EnvSource }): PreparedSchemaDiff {
  const { testEnv, developmentEnv, parentEnv } = input;
  const developmentDatabaseUrl = developmentEnv?.DATABASE_URL;
  const databaseUrl = testEnv.DATABASE_URL;
  rejectTarget(databaseUrl, {}, developmentDatabaseUrl, "TARGET_REJECTED");
  let passwords: { appPassword: string; adminPassword: string };
  try {
    passwords = assertTestDatabaseCredentials(testEnv);
  } catch (error) {
    if (error instanceof TestDatabaseCredentialsError) {
      throw new SchemaDiffError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  const verifiedUrl = databaseUrl as string;
  rejectTarget(verifiedUrl, parentEnv, developmentDatabaseUrl, "UNSAFE_PARENT_ENV");
  const { childEnv } = buildTestDbMigrateEnv(parentEnv, verifiedUrl);
  // 作った後の最終的な値で、もう一度検証する
  const target = rejectTarget(childEnv.DATABASE_URL, childEnv, developmentDatabaseUrl, "TARGET_REJECTED");
  const secrets = [verifiedUrl, passwords.appPassword, passwords.adminPassword, developmentDatabaseUrl, passwordOf(developmentDatabaseUrl)].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  return { target, checkInput: { databaseUrl: verifiedUrl, developmentDatabaseUrl }, childEnv, secrets };
}

/**
 * migrate diff を起動してよい権限か（必要条件だけ）。CREATE・DB の所有者のどれかがあれば違反。
 * 今の katana_test_user は migration 用に、これらをすべて持つので、必ず違反になる（Step 3-12B-5C で読み取り専用のロールの導入を承認後に検討）。
 * テーブルの所有権・INSERT/UPDATE/DELETE/TRUNCATE、default_transaction_read_only は、今の TestDatabasePrivileges では読めない（十分条件ではない）。
 */
export function readOnlyPrivilegeViolations(privileges: TestDatabasePrivileges): string[] {
  const violations: string[] = [];
  if (privileges.publicCreate) violations.push("public CREATE");
  if (privileges.databaseCreate) violations.push("database CREATE");
  if (privileges.databaseOwner) violations.push("database owner");
  return violations;
}

// ---- 実行の手順（スクリプトには未接続） ----

/** 差分の検証用の実DBへの接続の許可（固定のゲート）。migration 用の LiveDatabaseAccess とは別の型・別の値 */
export type SchemaDiffAccess = { readonly mode: "disabled" } | { readonly mode: "enabled" };
export const SCHEMA_DIFF_DISABLED: SchemaDiffAccess = Object.freeze({ mode: "disabled" });

export type SchemaDiffDeps = {
  root: string;
  execArgv: readonly string[];
  execPath: string;
  parentEnv: EnvSource;
  readEnvFile: (absolutePath: string) => EnvSource | undefined;
  pathExists: (absolutePath: string) => boolean;
  access: SchemaDiffAccess;
  readDockerIdentity: ReadDockerIdentity;
  inspectDatabase: InspectDatabase;
  /** 子プロセスを起動し、出力と終了を返す。timeoutMs を超えたら止めて timeout を返す */
  spawnCapture: (command: string, args: readonly string[], options: SchemaDiffSpawnOptions) => Promise<SchemaDiffProcessResult>;
  /** 固定のコマンドの組み立て（単体テストで、改ざんされたコマンドが拒否されることを確かめるためだけに差し替える） */
  buildCommand?: typeof buildSchemaDiffCommand;
  log: (text: string) => void;
};

const SCHEMA_DIFF_REQUIRED_PATHS = [PRISMA_CLI_ENTRY, PRISMA_CONFIG_FILE, PRISMA_SCHEMA_FILE];
const AFTER_CLI_NOTE = "The Prisma CLI already ran, so this is detection after the fact; the diff result is not trusted. Nothing was reset or repaired.";

function codeOf(error: unknown): string {
  if (error instanceof IntegrationDatabaseCheckError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : "unknown";
}

async function readDocker(deps: SchemaDiffDeps, label: "D1" | "D2" | "D3") {
  try {
    return await deps.readDockerIdentity({ root: deps.root, parentEnv: deps.parentEnv, readEnvFile: deps.readEnvFile });
  } catch (error) {
    throw new SchemaDiffError("DOCKER_IDENTITY_FAILED", `the docker identity check ${label} failed (${codeOf(error)}). ${label === "D3" ? AFTER_CLI_NOTE : "The Prisma CLI was not started."}`);
  }
}

async function inspect(deps: SchemaDiffDeps, checkInput: PreparedSchemaDiff["checkInput"], code: "STATE_CHECK_FAILED" | "POST_DIFF_CHECK_FAILED"): Promise<TestDatabaseInspection> {
  try {
    return await deps.inspectDatabase(checkInput);
  } catch (error) {
    throw new SchemaDiffError(code, `the database check failed (${codeOf(error)}). ${code === "POST_DIFF_CHECK_FAILED" ? AFTER_CLI_NOTE : "The Prisma CLI was not started."}`);
  }
}

/** 手順どおりに検証し、F2・D3 まで通ったときだけ、終了コードの分類を返す（成功は no-diff だけ） */
export async function runSchemaDiffCheck(deps: SchemaDiffDeps): Promise<SchemaDiffOutcome> {
  const { root } = deps;
  if (deps.execArgv.length > 0) throw new SchemaDiffError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");
  if (deps.parentEnv.NODE_OPTIONS !== undefined && deps.parentEnv.NODE_OPTIONS !== "") {
    throw new SchemaDiffError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before running the schema diff.");
  }
  const testEnv = deps.readEnvFile(path.join(root, TEST_ENV_FILE));
  if (testEnv === undefined) throw new SchemaDiffError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found.`);
  const developmentEnv = deps.readEnvFile(path.join(root, DEVELOPMENT_ENV_FILE));
  const prepared = prepareSchemaDiff({ testEnv, developmentEnv, parentEnv: deps.parentEnv });

  for (const relative of SCHEMA_DIFF_REQUIRED_PATHS) {
    if (!deps.pathExists(path.join(root, relative))) throw new SchemaDiffError("REQUIRED_FILE_MISSING", `${relative} was not found.`);
  }
  const expected = buildSchemaDiffCommand({ root, execPath: deps.execPath });
  const command = (deps.buildCommand ?? buildSchemaDiffCommand)({ root, execPath: deps.execPath });
  assertSchemaDiffCommand(command, expected);
  const options = buildSchemaDiffSpawnOptions(root, prepared.childEnv);

  // ゲート（スクリプトには未接続。無効なら Docker・DB・Prisma CLI に触れない）
  if (deps.access.mode !== "enabled") {
    throw new SchemaDiffError("SCHEMA_DIFF_LIVE_DISABLED", "live schema diff is disabled in this build; refusing to read Docker, connect to the test database or start the Prisma CLI.");
  }

  const docker1 = await readDocker(deps, "D1");
  const { state, privileges, server: server1 } = await inspect(deps, prepared.checkInput, "STATE_CHECK_FAILED");
  const identityMismatches = [...serverIdentityMismatches(server1), ...serverDockerMismatches(server1, docker1)];
  if (identityMismatches.length > 0) {
    throw new SchemaDiffError("SERVER_IDENTITY_MISMATCH", `the database server does not match the test container (${identityMismatches.join(", ")}); the Prisma CLI was not started.`);
  }
  if (state.state !== "C") {
    throw new SchemaDiffError("DATABASE_STATE_NOT_C", `the test database is in state ${state.state}, not C; the Prisma CLI was not started.`);
  }
  const violations = readOnlyPrivilegeViolations(privileges);
  if (violations.length > 0) {
    throw new SchemaDiffError("READ_ONLY_NOT_ENFORCED", `the connecting role can change the database (${violations.join(", ")}); read-only access is not enforced, so the Prisma CLI was not started.`);
  }
  const docker2 = await readDocker(deps, "D2");
  const changedBefore = dockerIdentityChanges(docker1, docker2);
  if (changedBefore.length > 0) {
    throw new SchemaDiffError("DOCKER_IDENTITY_MISMATCH", `the test database container changed (${changedBefore.join(", ")}); the Prisma CLI was not started.`);
  }

  let result: SchemaDiffProcessResult;
  try {
    result = await deps.spawnCapture(command.command, command.args, options);
  } catch (error) {
    result = { kind: "spawn-error", errorCode: codeOf(error) };
  }

  // 結果に関わらず、F2・D3 を行う（入れ替わり・変更があれば、差分の結果を信用しない）
  const { state: after, server: server2 } = await inspect(deps, prepared.checkInput, "POST_DIFF_CHECK_FAILED");
  const serverChanges = serverIdentityChanges(server1, server2);
  if (serverChanges.length > 0) {
    throw new SchemaDiffError("POST_DIFF_IDENTITY_MISMATCH", `the database server changed during the schema diff (${serverChanges.join(", ")}). ${AFTER_CLI_NOTE}`);
  }
  const changedAfter = dockerIdentityChanges(docker1, await readDocker(deps, "D3"));
  if (changedAfter.length > 0) {
    throw new SchemaDiffError("POST_DIFF_IDENTITY_MISMATCH", `the test database container changed during the schema diff (${changedAfter.join(", ")}). ${AFTER_CLI_NOTE}`);
  }
  if (after.state !== "C") {
    throw new SchemaDiffError("POST_DIFF_STATE_MISMATCH", `after the schema diff, the test database is in state ${after.state}, not C. ${AFTER_CLI_NOTE}`);
  }

  const outcome = classifySchemaDiffResult(result, prepared.secrets);
  deps.log(`[schemaDiff] ${prepared.target.host}:${prepared.target.port}/${prepared.target.database} as ${prepared.target.user} (password hidden): ${outcome.outcome}`);
  return outcome;
}
