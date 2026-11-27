import path from "node:path";
import {
  APP_DB_TARGET_KEY,
  APP_DB_TARGET_TEST,
  AppDatabaseTargetError,
  assertAppDatabaseTarget,
  TestDatabaseCredentialsError,
  TestDatabaseGuardError,
  type TestDatabaseTarget,
} from "../db/testDatabaseGuard.ts";
import { DEVELOPMENT_ENV_FILE, inheritAllowedEnv, TEST_ENV_FILE } from "./integrationEnv.ts";

/**
 * F-01 の E2E 用の開発サーバー（scripts/e2e-dev-server.mts）の本体（Step 4-13B）。
 *
 *   npm run e2e:dev-server             … 予行。検証と、起動予定のコマンド・環境変数の表示だけ（開発サーバーを起動しない。DB・Docker に触れない）
 *   npm run e2e:dev-server -- --start  … 起動の意思表示。固定のゲート（devServer）が有効なときだけ、検証の後に `next dev` を起動する。
 *                                        今はゲートが無効なので、検証の後、起動の前に E2E_DEV_SERVER_LIVE_DISABLED で止まる
 *
 * 外部とのやりとり（env ファイルの読み込み、ファイルの存在の確認、秘密の値の生成、子プロセスの起動、表示）は、すべて引数で受け取る。
 * このモジュールは child_process・DB ドライバ・Prisma を読み込まない。
 *
 * 起動する開発サーバー（P9。lib/prisma.ts の assertAppDatabaseTarget が、接続の前にもう一度確かめる）:
 * - `next dev --hostname 127.0.0.1 --port 3100`（自分の PC からだけ。開発用の localhost:3000 とは別。K7）
 * - 環境変数は、親の許可リストの変数（inheritAllowedEnv）と、次の固定の値だけ。親の DATABASE_URL・AUTH_SECRET・PG*・DOTENV_* などは渡さない:
 *   - DATABASE_URL：`.env.test` の値（Next が読む `.env` の開発用の値より優先される）
 *   - KATANA_DB_TARGET=test
 *   - AUTH_SECRET：起動のたびに作る、テスト専用の乱数（保存も表示もしない。`.env.local` の本物の値は使わない）
 *   - NEXT_TELEMETRY_DISABLED=1
 * - NODE_ENV は設定しない（`next dev` が development にする）。Auth.js は development でホストを信頼するので、AUTH_URL・AUTH_TRUST_HOST は設定しない。
 *
 * 表示・例外のメッセージには、接続URL・パスワード・AUTH_SECRET を含めない。
 */

export const E2E_DEV_SERVER_HOST = "127.0.0.1";
export const E2E_DEV_SERVER_PORT = "3100";
/** Next の CLI（node で直接起動する。shell・npx は使わない） */
export const NEXT_CLI_ENTRY = path.join("node_modules", "next", "dist", "bin", "next");
export const NEXT_DEV_ARGS = Object.freeze(["dev", "--hostname", E2E_DEV_SERVER_HOST, "--port", E2E_DEV_SERVER_PORT] as const);
/** 表示するときに値を伏せる環境変数 */
const HIDDEN_VALUE_KEYS = new Set(["DATABASE_URL", "AUTH_SECRET"]);
/** 落としたことを名前で表示する環境変数（接続先・読み込みに関わるもの） */
const NOTABLE_DROPPED_KEY = /^(PG|DOTENV_|NODE_|AUTH_|NEXTAUTH_|KATANA_|DATABASE_URL$|PORT$|HOSTNAME$)/;

/**
 * E2E 用の開発サーバーの起動の許可（8つ目の固定ゲート）。scripts/e2e-dev-server.mts は E2E_DEV_SERVER_DISABLED を固定で渡す。
 * 環境変数・引数（`--start` を含む）では変えられない。有効にするには、承認を得てスクリプトのコードを変え、commit する。
 */
export type E2eDevServerAccess = { readonly mode: "disabled" } | { readonly mode: "enabled" };
export const E2E_DEV_SERVER_DISABLED: E2eDevServerAccess = Object.freeze({ mode: "disabled" });

export type E2eDevServerErrorCode =
  | "ARGUMENTS_INVALID"
  | "NODE_EXEC_ARGV_PRESENT"
  | "NODE_OPTIONS_PRESENT"
  | "TEST_ENV_MISSING"
  | "TARGET_REJECTED"
  | "CREDENTIALS_REJECTED"
  | "SECRET_INVALID"
  | "REQUIRED_FILE_MISSING"
  | "E2E_DEV_SERVER_LIVE_DISABLED"
  | "START_FAILED";

export class E2eDevServerError extends Error {
  readonly code: E2eDevServerErrorCode;

  constructor(code: E2eDevServerErrorCode, detail: string) {
    super(`[e2e-dev-server] ${code}: ${detail}`);
    this.name = "E2eDevServerError";
    this.code = code;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;
export type E2eDevServerMode = "dry-run" | "start";

export function parseE2eDevServerArgs(args: readonly string[]): E2eDevServerMode {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--start") return "start";
  throw new E2eDevServerError("ARGUMENTS_INVALID", "the only accepted argument is --start.");
}

/** AUTH_SECRET の最短の長さ（base64url で 43 文字＝32 バイト） */
const MIN_SECRET_LENGTH = 43;

export type PreparedE2eDevServerEnv = {
  childEnv: Record<string, string>;
  target: TestDatabaseTarget;
  droppedKeys: string[];
};

/**
 * 開発サーバーに渡す環境変数を作り、接続先を検証する。DBには接続しない。
 * 検証は、開発サーバーの中の lib/prisma.ts と同じ関数（assertAppDatabaseTarget）を、作った後の最終的な環境変数で行う。
 */
export function prepareE2eDevServerEnv(input: {
  parentEnv: EnvSource;
  /** `.env.test` を dotenv.parse した結果。ファイルがなければ undefined */
  testEnv: EnvSource | undefined;
  /** `.env` を dotenv.parse した結果。ファイルがなければ undefined */
  developmentEnv: EnvSource | undefined;
  /** テスト専用の AUTH_SECRET を作る（scripts/e2e-dev-server.mts は node:crypto の乱数を渡す） */
  generateSecret: () => string;
}): PreparedE2eDevServerEnv {
  const { parentEnv, testEnv, developmentEnv } = input;
  if (testEnv === undefined) {
    throw new E2eDevServerError("TEST_ENV_MISSING", `${TEST_ENV_FILE} was not found; create it before starting the E2E dev server.`);
  }
  if (parentEnv.NODE_OPTIONS !== undefined && parentEnv.NODE_OPTIONS !== "") {
    throw new E2eDevServerError("NODE_OPTIONS_PRESENT", "NODE_OPTIONS is set; unset it before starting the E2E dev server.");
  }

  const secret = input.generateSecret();
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new E2eDevServerError("SECRET_INVALID", "the generated AUTH_SECRET is not a long enough random value.");
  }

  const { inherited, droppedKeys } = inheritAllowedEnv(parentEnv);
  const childEnv: Record<string, string> = { ...inherited };
  if (testEnv.DATABASE_URL !== undefined) childEnv.DATABASE_URL = testEnv.DATABASE_URL;
  childEnv[APP_DB_TARGET_KEY] = APP_DB_TARGET_TEST;
  childEnv.AUTH_SECRET = secret;
  childEnv.NEXT_TELEMETRY_DISABLED = "1";

  let target: TestDatabaseTarget;
  try {
    const result = assertAppDatabaseTarget({ env: childEnv, testEnv, developmentDatabaseUrl: developmentEnv?.DATABASE_URL });
    if (result.mode !== "test") throw new E2eDevServerError("TARGET_REJECTED", "the dev server environment is not in test mode.");
    target = result.target;
  } catch (error) {
    if (error instanceof AppDatabaseTargetError || error instanceof TestDatabaseGuardError) {
      throw new E2eDevServerError("TARGET_REJECTED", `the test database target was rejected (${error.code}).`);
    }
    if (error instanceof TestDatabaseCredentialsError) {
      throw new E2eDevServerError("CREDENTIALS_REJECTED", `the test database credentials in ${TEST_ENV_FILE} were rejected (${error.code}).`);
    }
    throw error;
  }
  return { childEnv, target, droppedKeys };
}

export type E2eDevServerDeps = {
  root: string;
  argv: readonly string[];
  execArgv: readonly string[];
  execPath: string;
  parentEnv: EnvSource;
  readEnvFile: (filePath: string) => Record<string, string> | undefined;
  pathExists: (filePath: string) => boolean;
  generateSecret: () => string;
  /** 8つ目の固定ゲート。scripts/e2e-dev-server.mts は E2E_DEV_SERVER_DISABLED を固定で渡す */
  devServer: E2eDevServerAccess;
  /** ゲートが有効で `--start` のときだけ呼ぶ。開発サーバーが終了したときの終了コードを返す */
  spawn: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; shell: false; stdio: "inherit" }) => Promise<number>;
  log: (text: string) => void;
};

function formatPlan(heading: string, deps: E2eDevServerDeps, prepared: PreparedE2eDevServerEnv, args: readonly string[]): string {
  const { target, childEnv, droppedKeys } = prepared;
  return [
    heading,
    "",
    `connection target: verified ${target.host}:${target.port}/${target.database} as ${target.user} (${TEST_ENV_FILE} DATABASE_URL; password hidden)`,
    `dev server: http://${E2E_DEV_SERVER_HOST}:${E2E_DEV_SERVER_PORT} (bound to ${E2E_DEV_SERVER_HOST} only)`,
    `working directory: ${deps.root}`,
    `command: ${path.basename(deps.execPath)} ${args.map((arg) => (path.isAbsolute(arg) ? path.relative(deps.root, arg) : arg)).join(" ")} (no shell)`,
    `dev server gate: ${deps.devServer.mode === "enabled" ? "enabled" : "disabled in this build (--start stops with E2E_DEV_SERVER_LIVE_DISABLED before starting)"}`,
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

export async function runE2eDevServer(deps: E2eDevServerDeps): Promise<number> {
  // 1. 引数  2. Node の起動オプション
  const mode = parseE2eDevServerArgs(deps.argv);
  if (deps.execArgv.length > 0) throw new E2eDevServerError("NODE_EXEC_ARGV_PRESENT", "Node.js options for this script are not allowed.");

  // 3. .env.test・.env の読み込みと、環境変数の作成・検証（DBには接続しない）
  const prepared = prepareE2eDevServerEnv({
    parentEnv: deps.parentEnv,
    testEnv: deps.readEnvFile(path.join(deps.root, TEST_ENV_FILE)),
    developmentEnv: deps.readEnvFile(path.join(deps.root, DEVELOPMENT_ENV_FILE)),
    generateSecret: deps.generateSecret,
  });

  // 4. 必要なファイル
  const cli = path.join(deps.root, NEXT_CLI_ENTRY);
  if (!deps.pathExists(cli)) throw new E2eDevServerError("REQUIRED_FILE_MISSING", `${NEXT_CLI_ENTRY} was not found.`);
  const args = [cli, ...NEXT_DEV_ARGS];

  if (mode === "dry-run") {
    deps.log(formatPlan("[e2e-dev-server] dry run (--start was not given): the dev server was not started and no database connection was made.", deps, prepared, args));
    return 0;
  }

  // 5. 8つ目の固定ゲート。「enabled」と完全に一致しなければ、起動しない
  if (deps.devServer.mode !== "enabled") {
    throw new E2eDevServerError(
      "E2E_DEV_SERVER_LIVE_DISABLED",
      "the E2E dev server gate is disabled in this build (--start alone does not enable it); refusing to start the dev server.",
    );
  }

  deps.log(formatPlan("[e2e-dev-server] starting the E2E dev server (stop it with Ctrl+C).", deps, prepared, args));
  try {
    return await deps.spawn(deps.execPath, args, { cwd: deps.root, env: prepared.childEnv, shell: false, stdio: "inherit" });
  } catch {
    throw new E2eDevServerError("START_FAILED", "the dev server could not be started.");
  }
}
