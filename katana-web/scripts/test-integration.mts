/**
 * 統合テスト（*.integration.test.*）専用の runner。
 *
 *   npm run test:integration        … 接続先を検証してから、Vitest を vitest.integration.config.ts で起動する
 *   npm run test:integration:check  … 検証と、子プロセスに渡す設定の表示だけを行う（Vitest を起動せず、DBにも接続しない）
 *
 * - テストDBの接続URLは `.env.test` の DATABASE_URL だけから受け取る。親プロセスの DATABASE_URL・`.env` の値は使わない。
 * - 検証に失敗したら子プロセスを起動しない。子プロセスは shell を使わずに起動し、作業ディレクトリは katana-web/ に固定する。
 * - 接続URL・パスワード・接続先は表示しない。
 * - 引数は `--check` 以外を受け付けない（Vitest へのオプションの受け渡しはしない）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_ENV_FILE,
  INTEGRATION_TEST_INCLUDE,
  INTEGRATION_VITEST_CONFIG,
  IntegrationRunnerError,
  listIntegrationTestFiles,
  prepareIntegrationEnv,
  readEnvFile,
  TEST_ENV_FILE,
} from "../lib/testing/integrationEnv.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 表示するときに値を伏せる環境変数 */
const HIDDEN_VALUE_KEYS = new Set(["DATABASE_URL"]);
/** 落としたことを名前で表示する環境変数（接続先・読み込みに関わるもの） */
const NOTABLE_DROPPED_KEY = /^(PG|DOTENV_|NODE_|VITE|KATANA_|DATABASE_URL$)/;

type Mode = "run" | "check";

function parseMode(args: string[]): Mode {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "--check") return "check";
  throw new IntegrationRunnerError("unsupported arguments; the only accepted argument is --check.");
}

function requireFile(relative: string): string {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) throw new IntegrationRunnerError(`${relative} was not found.`);
  return absolute;
}

function printCheck(childEnv: Record<string, string>, droppedKeys: string[], args: string[]): void {
  const testFiles = listIntegrationTestFiles(ROOT).sort();
  const lines = [
    "[test-integration] check mode: Vitest was not started and no database connection was made.",
    "",
    `connection target: verified (${TEST_ENV_FILE} DATABASE_URL; value hidden)`,
    `working directory: ${ROOT}`,
    `command: ${path.basename(process.execPath)} ${args.map((arg) => path.relative(ROOT, arg) || arg).join(" ")} (no shell)`,
    "",
    "child environment:",
    ...Object.keys(childEnv)
      .sort()
      .map((key) => `  ${key}=${HIDDEN_VALUE_KEYS.has(key) ? "(hidden)" : childEnv[key]}`),
    "",
    `dropped from the parent environment: ${droppedKeys.length} variable(s)`,
    ...droppedKeys.filter((key) => NOTABLE_DROPPED_KEY.test(key)).map((key) => `  ${key}`),
    "",
    `test files matching ${INTEGRATION_TEST_INCLUDE}: ${testFiles.length}`,
    ...testFiles.map((file) => `  ${file}`),
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  // --import・--require などで、runner より先にコードが読み込まれていないこと
  if (process.execArgv.length > 0) {
    throw new IntegrationRunnerError("Node.js options for the runner are not allowed.");
  }

  const { childEnv, droppedKeys } = prepareIntegrationEnv({
    parentEnv: process.env,
    testEnv: readEnvFile(path.join(ROOT, TEST_ENV_FILE)),
    developmentEnv: readEnvFile(path.join(ROOT, DEVELOPMENT_ENV_FILE)),
  });
  const vitestArgs = [
    requireFile(path.join("node_modules", "vitest", "vitest.mjs")),
    "run",
    "--config",
    requireFile(INTEGRATION_VITEST_CONFIG),
  ];

  if (mode === "check") {
    printCheck(childEnv, droppedKeys, vitestArgs);
    return 0;
  }

  const child = spawn(process.execPath, vitestArgs, { cwd: ROOT, env: childEnv, stdio: "inherit", shell: false });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    // シグナルで終了した場合（code が null）も失敗として扱う
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 想定したエラーは、接続先を含まないメッセージだけを表示する
    console.error(error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
