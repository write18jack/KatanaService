/**
 * 読み取り専用ロール katana_test_ro の準備（Step 3-12B-5E-3）。
 *
 *   npm run testdb:ro-role:create        … 予行（--create）。事前の検証と、実行予定の docker exec の表示だけ（Docker・DB に触れない）
 *   npm run testdb:ro-role:grant-sync    … 予行（--grant-sync）。同上
 *   npm run testdb:ro-role:preflight-create
 *                                        … 読み取り専用の事前検証（--preflight-create）。D1・F1・FP0・A0・D2 だけ。
 *                                          DB への接続は読み取り専用のトランザクションだけで、docker exec・DB の変更はしない
 *   node scripts/testdb-ro-role.mts --create --apply / --grant-sync --apply
 *                                        … 実行の意思表示。操作ごとの固定のゲートが無効なので、今は Docker・DB に触れる前に
 *                                          RO_ROLE_CREATE_DISABLED・RO_ROLE_GRANT_SYNC_DISABLED で止まる
 *
 * 手順と検証の内容は lib/testing/testDbReadOnlyRoleRunner.ts・lib/testing/testDbReadOnlyRole.ts。このファイルは、実際の入出力をつなぐだけ。
 * ゲートは固定の RO_ROLE_CREATE_DISABLED・RO_ROLE_GRANT_SYNC_DISABLED（環境変数・引数では変えられない）。
 * 有効にするのは、承認を得た後続の工程で、このファイルを変えたときだけ。ゲートの有効化と実行（--apply）は、別々に承認を得る。
 *
 * docker exec の起動（execWithInput）は、shell なし（shell: false）・固定のコマンド "docker" だけ。引数はランナーが固定の配列と照合した後に渡す。
 * 標準入力には、SHA-256 を照合した固定の SQL ファイルの中身だけを渡す。出力は呼び出し側が伏せてから表示する。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationRunnerError, readEnvFile } from "../lib/testing/integrationEnv.ts";
import { loadCatalogAuditExpectation, runCatalogDefinitionAudit } from "../lib/testing/testDbCatalogAudit.ts";
import { connectTestDatabase } from "../lib/testing/testDbConnection.ts";
import { readTestDbDockerIdentity, runDockerCommand } from "../lib/testing/testDbDocker.ts";
import { createTestDatabaseInspector } from "../lib/testing/testDbMigrate.ts";
import {
  ReadOnlyRoleError,
  RO_ROLE_CREATE_DISABLED,
  RO_ROLE_GRANT_SYNC_DISABLED,
  runPreChangeAclCheck,
  runReadOnlyRoleCheck,
} from "../lib/testing/testDbReadOnlyRole.ts";
import {
  type ReadOnlyRoleExecOptions,
  type ReadOnlyRoleExecResult,
  runTestDbReadOnlyRole,
  TestDbReadOnlyRoleError,
} from "../lib/testing/testDbReadOnlyRoleRunner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_CAPTURE = 64 * 1024;

/** 固定のコマンド（docker）を shell なしで起動し、標準入力に input を書いて閉じる。timeoutMs を超えたら止めて timeout を返す */
function execWithInput(command: string, args: readonly string[], options: ReadOnlyRoleExecOptions): Promise<ReadOnlyRoleExecResult> {
  if (command !== "docker" || options.shell !== false) return Promise.resolve({ kind: "spawn-error", errorCode: "COMMAND_NOT_ALLOWED" });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: ReadOnlyRoleExecResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ kind: "spawn-error", errorCode: typeof error.code === "string" ? error.code : "unknown" });
    });
    // 子プロセスが終わるまで待ってから返す（タイムアウトのときも、終了の後に事後の検査が始まる）
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish(timedOut ? { kind: "timeout", stdout, stderr } : { kind: "exit", code, signal, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input, "utf8");
  });
}

runTestDbReadOnlyRole({
  root: ROOT,
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  parentEnv: process.env,
  readEnvFile,
  pathExists: existsSync,
  readFile: (absolutePath) => readFileSync(absolutePath, "utf8"),
  loadExpectation: () => loadCatalogAuditExpectation(ROOT),
  // 読み取り専用ロールの作成・補完の許可は無効（固定）。--apply でも、Docker の読み取り・DBへの接続の前に止まる
  createGate: RO_ROLE_CREATE_DISABLED,
  grantSyncGate: RO_ROLE_GRANT_SYNC_DISABLED,
  readDockerIdentity: (input) => readTestDbDockerIdentity({ ...input, run: runDockerCommand }),
  inspectDatabase: (input) => createTestDatabaseInspector({ root: ROOT, connect: connectTestDatabase })(input),
  runAudit: (input) => runCatalogDefinitionAudit({ ...input, connect: connectTestDatabase }),
  checkReadOnlyRole: (input) => runReadOnlyRoleCheck({ ...input, connect: connectTestDatabase }),
  checkPreChangeAcl: (input) => runPreChangeAclCheck({ ...input, connect: connectTestDatabase }),
  exec: execWithInput,
  log: (text) => console.log(text),
}).then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    // 想定したエラーは、秘密情報を含まないメッセージだけを表示する
    console.error(error instanceof TestDbReadOnlyRoleError || error instanceof ReadOnlyRoleError || error instanceof IntegrationRunnerError ? error.message : error);
    process.exitCode = 1;
  },
);
