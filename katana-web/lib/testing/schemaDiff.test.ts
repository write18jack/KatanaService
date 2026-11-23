import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_TEST_ENV_FILE,
  SCHEMA_DIFF_CLI_ENTRY,
  SCHEMA_DIFF_FIXED_ENV,
  SCHEMA_DIFF_RO_URL_SHA256_ENV,
  schemaDiffUrlSha256,
} from "../db/prismaCliGuard";
import {
  assertSchemaDiffBinaries,
  assertSchemaDiffCommand,
  buildSchemaDiffCommand,
  buildSchemaDiffEnv,
  buildSchemaDiffSpawnOptions,
  classifySchemaDiffResult,
  createSchemaDiffInterruptController,
  createSchemaDiffSpawnCapture,
  FORBIDDEN_SCHEMA_DIFF_ARGS,
  NO_SCHEMA_DIFF_INTERRUPTS,
  redactSecrets,
  SCHEMA_DIFF_BINARY_SHA256,
  SCHEMA_DIFF_DISABLED,
  SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS,
  SCHEMA_DIFF_INTERRUPT_DEADLINE_MS,
  SCHEMA_DIFF_KILL_GRACE_MS,
  SCHEMA_DIFF_MAX_CAPTURE,
  SCHEMA_DIFF_SCOPE_NOTE,
  SCHEMA_DIFF_TIMEOUT_MS,
  type SchemaDiffChild,
  SchemaDiffError,
  schemaDiffEnvViolations,
  type SchemaDiffInterruptEvent,
  type SchemaDiffInterrupts,
  type SchemaDiffInterruptSignal,
  type SchemaDiffProcessDeps,
  type SchemaDiffProcessResult,
  schemaDiffSucceeded,
  SCHEMA_ENGINE_BINARY,
} from "./schemaDiff";
import { LIVE_DATABASE_DISABLED, PRISMA_CLI_ENTRY } from "./testDbMigrate";
import { READ_ONLY_ROLE_ENV_FILE } from "./testDbReadOnlyRole";

// Prisma CLI・schema engine を起動せず、DBにも Docker にも接続しない。子プロセスの起動・シグナル・タイマーは、すべて偽の関数で置き換える。
// CLI・engine の実体は、SHA-256 の照合のために読むだけ（実行しない）
const ROOT = "/fake/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const EXEC_PATH = "/fake/bin/node";
const APP_PASSWORD = "diff-dummy-app-pass";
const ADMIN_PASSWORD = "diff-dummy-admin-pass";
const RO_PASSWORD = "diff_dummy_ro_password_0123456789abcdef";
const APP_URL = `postgresql://katana_test_user:${APP_PASSWORD}@127.0.0.1:5434/katana_test`;
const RO_URL = `postgresql://katana_test_ro:${RO_PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
/** 伏せる値として渡すもの（runner の secrets と同じ種類。汎用の接頭辞は含めない） */
const REDACT = [APP_URL, APP_PASSWORD, ADMIN_PASSWORD, RO_URL, RO_PASSWORD, DEV_URL, DEV_PASSWORD];
const SECRETS = [...REDACT, "postgresql://katana", "postgres://"];

const EXPECTED_ARGS = [
  `${ROOT}/node_modules/prisma/build/index.js`,
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  `${ROOT}/prisma/schema.prisma`,
  "--exit-code",
  "--config",
  `${ROOT}/prisma.schemadiff.config.ts`,
];

const exit = (code: number | null, stdout = "", stderr = "", signal: string | null = null): SchemaDiffProcessResult => ({ kind: "exit", code, signal, stdout, stderr, processGroup: "stopped" });
const code = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

describe("固定のコマンド", () => {
  it("1. 正しい固定コマンドを組み立てる（専用の設定ファイル prisma.schemadiff.config.ts。--script・--output・migrations・shadow なし）", () => {
    const command = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    expect(command.command).toBe(EXEC_PATH);
    expect(command.args).toEqual(EXPECTED_ARGS);
    for (const flag of ["--script", "--output", "-o", "--from-migrations", "--to-migrations", "--shadow-database-url", "--from-url", "--to-url"]) expect(command.args).not.toContain(flag);
    expect(command.args.some((arg) => arg.endsWith("/prisma.config.ts"))).toBe(false);
    expect(SCHEMA_DIFF_CLI_ENTRY).toBe(PRISMA_CLI_ENTRY);
  });

  it("2. shell: false・detached（新しいプロセスグループ）・標準入力なし・タイムアウトと猶予付きの起動オプション", () => {
    const options = buildSchemaDiffSpawnOptions(ROOT, { PATH: "/usr/bin" });
    expect(options).toEqual({
      cwd: ROOT,
      env: { PATH: "/usr/bin" },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: SCHEMA_DIFF_TIMEOUT_MS,
      killGraceMs: SCHEMA_DIFF_KILL_GRACE_MS,
      groupCheckIntervalMs: SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS,
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.env)).toBe(true);
  });

  it("3. 引数を追加する経路がない（組み立ての関数は root・execPath だけを受け取り、結果は凍結されている）", () => {
    const command = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH, extra: ["--script"] } as never);
    expect(command.args).toEqual(EXPECTED_ARGS);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
    expect(() => (command.args as string[]).push("--script")).toThrow();
  });

  it("3. 固定のコマンドに引数を足した・減らした・並べ替えた・コマンドを差し替えたものは拒否する", () => {
    const expected = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    for (const args of [[...EXPECTED_ARGS, "--script"], [...EXPECTED_ARGS, "--output", "/tmp/x"], EXPECTED_ARGS.slice(0, -1), [...EXPECTED_ARGS].reverse()]) {
      expect(() => assertSchemaDiffCommand({ command: EXEC_PATH, args }, expected)).toThrow(SchemaDiffError);
    }
    expect(() => assertSchemaDiffCommand({ command: "/bin/sh", args: EXPECTED_ARGS }, expected)).toThrow(SchemaDiffError);
    expect(() => assertSchemaDiffCommand(expected, expected)).not.toThrow();
  });

  it("4. diff 以外の Prisma コマンド・書き込み系（migrate deploy/dev/reset/resolve・db push/execute/pull・generate）・--script・--output は拒否する（期待値が改ざんされていても）", () => {
    const expected = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    const entry = EXPECTED_ARGS[0];
    const config = EXPECTED_ARGS.at(-1) as string;
    for (const sub of [["migrate", "deploy"], ["migrate", "dev"], ["migrate", "reset", "--force"], ["migrate", "resolve"], ["db", "push"], ["db", "execute", "--stdin"], ["db", "pull"], ["generate"]]) {
      const command = { command: EXEC_PATH, args: [entry, ...sub, "--config", config] };
      expect(() => assertSchemaDiffCommand(command, expected)).toThrow(/COMMAND_REJECTED/);
      expect(() => assertSchemaDiffCommand(command, command)).toThrow(/COMMAND_REJECTED/);
    }
    for (const extra of [["--script"], ["--output", "/tmp/x.sql"], ["-o", "x"], ["--shadow-database-url", "x"], ["--from-migrations", "prisma/migrations"]]) {
      const command = { command: EXEC_PATH, args: [...EXPECTED_ARGS, ...extra] };
      expect(() => assertSchemaDiffCommand(command, command)).toThrow(/COMMAND_REJECTED/);
    }
    for (const word of ["deploy", "dev", "push", "reset", "resolve", "execute", "pull", "generate", "--script", "--output", "--from-migrations", "--to-migrations", "--from-url", "--to-url"]) {
      expect(FORBIDDEN_SCHEMA_DIFF_ARGS.has(word)).toBe(true);
    }
  });

  it("4. 開発用・migration 用の prisma.config.ts を使うコマンドは拒否する（期待値が改ざんされていても）", () => {
    const withDefault = { command: EXEC_PATH, args: [...EXPECTED_ARGS.slice(0, -1), `${ROOT}/prisma.config.ts`] };
    expect(() => assertSchemaDiffCommand(withDefault, withDefault)).toThrow(/COMMAND_REJECTED/);
    const withoutConfig = { command: EXEC_PATH, args: EXPECTED_ARGS.slice(0, -2) };
    expect(() => assertSchemaDiffCommand(withoutConfig, withoutConfig)).toThrow(/COMMAND_REJECTED/);
  });
});

describe("子プロセスの環境変数（URL は入れず、SHA-256 だけ）", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LC_ALL: "C",
    CI: "false",
    RUST_LOG: "debug",
    RUST_BACKTRACE: "full",
    DATABASE_URL: DEV_URL,
    PRISMA_SCHEMA_ENGINE_BINARY: "/evil",
    PRISMA_MIGRATION_ENGINE_BINARY: "/evil",
    FORCE_PANIC_SCHEMA_ENGINE: "1",
    DEBUG: "*",
    NODE_OPTIONS: "--require x",
    KATANA_DB_TARGET: "test",
    KATANA_TEST_RO_DATABASE_URL: RO_URL,
    SECRET_TOKEN: "t",
  };

  it("許可リスト・固定の値（CHECKPOINT_DISABLE=1・CI=1・RUST_LOG=error・RUST_BACKTRACE=0）・接続先モード・URL の SHA-256 だけ", () => {
    const { childEnv, droppedKeys } = buildSchemaDiffEnv(parent, RO_URL);
    expect(childEnv).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      CHECKPOINT_DISABLE: "1",
      CI: "1",
      RUST_LOG: "error",
      RUST_BACKTRACE: "0",
      KATANA_DB_TARGET: "test-readonly",
      [SCHEMA_DIFF_RO_URL_SHA256_ENV]: schemaDiffUrlSha256(RO_URL),
    });
    expect(SCHEMA_DIFF_FIXED_ENV).toEqual({ CHECKPOINT_DISABLE: "1", CI: "1", RUST_LOG: "error", RUST_BACKTRACE: "0" });
    for (const key of ["DATABASE_URL", "PRISMA_SCHEMA_ENGINE_BINARY", "PRISMA_MIGRATION_ENGINE_BINARY", "FORCE_PANIC_SCHEMA_ENGINE", "DEBUG", "NODE_OPTIONS", "KATANA_TEST_RO_DATABASE_URL", "SECRET_TOKEN"]) {
      expect(childEnv).not.toHaveProperty(key);
      expect(droppedKeys).toContain(key);
    }
    const text = JSON.stringify(childEnv);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(schemaDiffEnvViolations(childEnv, RO_URL, REDACT)).toEqual([]);
  });

  it("違反を検出する（許可しない名前・URL や秘密の値を含む値・固定の値の違い・接続先モード・SHA-256 の不一致）", () => {
    const { childEnv } = buildSchemaDiffEnv({ PATH: "/usr/bin" }, RO_URL);
    expect(schemaDiffEnvViolations({ ...childEnv, DATABASE_URL: RO_URL }, RO_URL, REDACT)).toEqual(["DATABASE_URL is not allowed", "DATABASE_URL contains a connection URL or a secret"]);
    expect(schemaDiffEnvViolations({ ...childEnv, PATH: `/usr/bin:${RO_PASSWORD}` }, RO_URL, REDACT)).toEqual(["PATH contains a connection URL or a secret"]);
    expect(schemaDiffEnvViolations({ ...childEnv, HOME: "postgres://x" }, RO_URL, REDACT)).toEqual(["HOME contains a connection URL or a secret"]);
    expect(schemaDiffEnvViolations({ ...childEnv, CHECKPOINT_DISABLE: "0" }, RO_URL, REDACT)).toEqual(["CHECKPOINT_DISABLE is not 1"]);
    expect(schemaDiffEnvViolations({ ...childEnv, RUST_LOG: "info" }, RO_URL, REDACT)).toEqual(["RUST_LOG is not error"]);
    expect(schemaDiffEnvViolations({ ...childEnv, KATANA_DB_TARGET: "test" }, RO_URL, REDACT)).toEqual(["KATANA_DB_TARGET is not test-readonly"]);
    expect(schemaDiffEnvViolations(childEnv, APP_URL, REDACT)).toEqual([`${SCHEMA_DIFF_RO_URL_SHA256_ENV} does not match the verified URL`]);
    const withoutCi = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== "CI"));
    expect(schemaDiffEnvViolations(withoutCi, RO_URL, REDACT)).toEqual(["CI is not 1"]);
  });
});

describe("CLI・engine の SHA-256（読むだけで、実行しない）", () => {
  const readReal = (p: string) => readFileSync(path.join(REPO_ROOT, path.relative(ROOT, p)));

  it("固定の値は、インストール済みの Prisma 7.2.0 の CLI のエントリと engine の実体と一致する", () => {
    expect(SCHEMA_DIFF_BINARY_SHA256.cli.file).toBe(PRISMA_CLI_ENTRY);
    expect(SCHEMA_DIFF_BINARY_SHA256.engine.file).toBe(SCHEMA_ENGINE_BINARY);
    expect(() => assertSchemaDiffBinaries({ root: ROOT, platform: "darwin", arch: "arm64", readBinary: readReal })).not.toThrow();
    expect(JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules/prisma/package.json"), "utf8")).version).toBe("7.2.0");
  });

  it("1バイトでも違えば・読めなければ・darwin-arm64 以外なら、起動しない", () => {
    const tampered = (p: string) => (p.endsWith("index.js") ? Buffer.from("tampered") : readReal(p));
    expect(() => assertSchemaDiffBinaries({ root: ROOT, platform: "darwin", arch: "arm64", readBinary: tampered })).toThrow(/BINARY_HASH_MISMATCH.*index\.js/);
    const engineTampered = (p: string) => (p.endsWith("schema-engine-darwin-arm64") ? Buffer.concat([readReal(p), Buffer.from([0])]) : readReal(p));
    expect(() => assertSchemaDiffBinaries({ root: ROOT, platform: "darwin", arch: "arm64", readBinary: engineTampered })).toThrow(/BINARY_HASH_MISMATCH.*schema-engine/);
    const missing = () => {
      throw Object.assign(new Error(`ENOENT ${RO_URL}`), { code: "ENOENT" });
    };
    const error = (() => {
      try {
        assertSchemaDiffBinaries({ root: ROOT, platform: "darwin", arch: "arm64", readBinary: missing });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(error.message).toMatch(/BINARY_HASH_MISMATCH/);
    expect(error.message).not.toContain(RO_PASSWORD);
    for (const [platform, arch] of [["linux", "x64"], ["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
      expect(() => assertSchemaDiffBinaries({ root: ROOT, platform, arch, readBinary: readReal })).toThrow(/PLATFORM_NOT_SUPPORTED/);
    }
  });
});

describe("終了コードの分類", () => {
  it("5. 0 は差分なし（成功）", () => {
    const outcome = classifySchemaDiffResult(exit(0, "No difference detected."), REDACT);
    expect(outcome).toEqual({ outcome: "no-diff" });
    expect(schemaDiffSucceeded(outcome)).toBe(true);
  });

  it("6. 1 は CLI のエラー（差分ありとは別）", () => {
    const outcome = classifySchemaDiffResult(exit(1, "", "Error: P1001"), REDACT);
    expect(outcome.outcome).toBe("cli-error");
    expect(schemaDiffSucceeded(outcome)).toBe(false);
  });

  it("7. 2 は差分あり（エラーとは別。要約を返す）", () => {
    const outcome = classifySchemaDiffResult(exit(2, "[*] Changed the `Shop` table"), REDACT);
    expect(outcome).toEqual({ outcome: "diff", summary: "[*] Changed the `Shop` table" });
    expect(schemaDiffSucceeded(outcome)).toBe(false);
  });

  it("8. 未知の終了コード（3・101・-1・null・小数）は想定外として拒否する", () => {
    for (const c of [3, 101, -1, 255, null, 1.5]) {
      const outcome = classifySchemaDiffResult(exit(c), REDACT);
      expect(outcome.outcome).toBe("unexpected-exit");
      expect(schemaDiffSucceeded(outcome)).toBe(false);
    }
  });

  it("9. 起動の失敗は spawn-failed（コードだけ。パス・メッセージは含めない）", () => {
    expect(classifySchemaDiffResult({ kind: "spawn-error", errorCode: "ENOENT" }, REDACT)).toEqual({ outcome: "spawn-failed", errorCode: "ENOENT" });
    expect(classifySchemaDiffResult({ kind: "spawn-error", errorCode: `bad ${RO_URL}` }, REDACT)).toEqual({ outcome: "spawn-failed", errorCode: "unknown" });
  });

  it("10. タイムアウト・シグナルでの終了は、どちらも成功ではない（終了コード 0 と一緒でもシグナルを優先する）", () => {
    expect(classifySchemaDiffResult({ kind: "timeout", stdout: "", stderr: "", processGroup: "stopped" }, REDACT).outcome).toBe("timeout");
    expect(classifySchemaDiffResult({ kind: "interrupted", signal: "SIGINT", stdout: "", stderr: "", processGroup: "stopped" }, REDACT)).toEqual({
      outcome: "interrupted",
      signal: "SIGINT",
      output: "",
    });
    expect(classifySchemaDiffResult(exit(null, "", "", "SIGKILL"), REDACT)).toEqual({ outcome: "signal", signal: "SIGKILL" });
    expect(classifySchemaDiffResult(exit(0, "", "", "SIGTERM"), REDACT).outcome).toBe("signal");
    expect(classifySchemaDiffResult(exit(null, "", "", "weird"), REDACT)).toEqual({ outcome: "signal", signal: "unknown" });
  });

  it("12. CLI の出力の接続URL・パスワード（ro・アプリ用・管理用・開発用）を伏せる。知らない接続URL・JSON の中の URL も伏せる。長い出力は切り詰める", () => {
    const engineJson = JSON.stringify({ fields: { message: `P1000 Authentication failed for ${RO_URL}`, datasource: { url: RO_URL } } });
    const noisy = `Error: ${engineJson} password=${RO_PASSWORD} app=${APP_PASSWORD} admin=${ADMIN_PASSWORD} dev=${DEV_URL} other=postgres://x:y@h/db`;
    for (const outcome of [
      classifySchemaDiffResult(exit(1, noisy, noisy), REDACT),
      classifySchemaDiffResult(exit(2, noisy), REDACT),
      classifySchemaDiffResult({ kind: "timeout", stdout: noisy, stderr: noisy, processGroup: "stopped" }, REDACT),
      classifySchemaDiffResult({ kind: "interrupted", signal: "SIGTERM", stdout: noisy, stderr: noisy, processGroup: "not-confirmed" }, REDACT),
      classifySchemaDiffResult(exit(7, noisy), REDACT),
    ]) {
      const text = JSON.stringify(outcome);
      for (const s of [...SECRETS, "x:y@h"]) expect(text).not.toContain(s);
    }
    expect(redactSecrets("a".repeat(20_000), []).length).toBeLessThan(9_000);
  });
});

// ---- プロセスグループごと止める起動（偽の spawn・kill・タイマー） ----

type FakeChild = SchemaDiffChild & { emit: { stdout: (t: string) => void; stderr: (t: string) => void; error: (e: Error) => void; close: (code: number | null, signal: string | null) => void } };

function fakeChild(pid: number | undefined): FakeChild {
  const listeners: Record<string, ((...a: never[]) => void)[]> = {};
  const add = (name: string, fn: (...a: never[]) => void) => (listeners[name] ??= []).push(fn);
  const fire = (name: string, ...args: unknown[]) => (listeners[name] ?? []).forEach((fn) => (fn as (...a: unknown[]) => void)(...args));
  return {
    pid,
    stdout: { on: (_e: "data", fn: (c: Buffer | string) => void) => add("stdout", fn as never) },
    stderr: { on: (_e: "data", fn: (c: Buffer | string) => void) => add("stderr", fn as never) },
    on: ((event: string, fn: (...a: never[]) => void) => add(event, fn)) as SchemaDiffChild["on"],
    emit: {
      stdout: (t) => fire("stdout", Buffer.from(t)),
      stderr: (t) => fire("stderr", Buffer.from(t)),
      error: (e) => fire("error", e),
      close: (c, s) => fire("close", c, s),
    },
  };
}

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };

/** 偽の中断（createSchemaDiffInterruptController の代わり。fire で通知する） */
function fakeInterrupts(): SchemaDiffInterrupts & { fire: (signal: SchemaDiffInterruptSignal, force?: boolean) => void; listenerCount: () => number } {
  let received: SchemaDiffInterruptSignal | undefined;
  const listeners = new Set<(event: SchemaDiffInterruptEvent) => void>();
  return {
    received: () => received,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (signal, force = false) => {
      received ??= signal;
      for (const listener of [...listeners]) listener({ signal, force });
    },
    listenerCount: () => listeners.size,
  };
}

/** groupAlive：グループの確認（kill(-pgid, 0)）で「残っている」と答える回数。Infinity なら、ずっと残っている */
function processHarness(child: FakeChild | Error, groupAlive = 0) {
  const timers: FakeTimer[] = [];
  const kills: [number, string][] = [];
  let aliveLeft = groupAlive;
  const deps: SchemaDiffProcessDeps = {
    spawn: vi.fn(() => {
      if (child instanceof Error) throw child;
      return child;
    }),
    killGroup: vi.fn((pgid: number, signal: "SIGTERM" | "SIGKILL") => {
      kills.push([pgid, signal]);
    }),
    groupExists: vi.fn(() => {
      if (aliveLeft > 0) {
        aliveLeft -= 1;
        return true;
      }
      return false;
    }),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as FakeTimer).cleared = true;
    },
  };
  /** 消されていない最後のタイマー（ms が一致するもの）を進める */
  const fire = (ms: number) => {
    const timer = [...timers].reverse().find((t) => !t.cleared && t.ms === ms);
    if (!timer) throw new Error(`no pending timer of ${ms} ms`);
    timer.cleared = true;
    timer.fn();
  };
  const pending = () => timers.filter((t) => !t.cleared);
  return { deps, timers, kills, fire, pending, capture: createSchemaDiffSpawnCapture(deps) };
}

const OPTIONS = buildSchemaDiffSpawnOptions(ROOT, { PATH: "/usr/bin" });

function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  const done = promise.then((value) => {
    state.settled = true;
    return value;
  });
  return { state, done };
}

describe("起動とタイムアウト（新しいプロセスグループ。タイムアウトでは engine を含むグループごと止める）", () => {
  it("shell なし・detached・標準入力なしで起動し、終了まで待って出力と終了コードを返す。終了後、グループの残り（engine など）に SIGKILL を送り、グループが消えたことを確かめる", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const pending = h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS);
    expect(h.deps.spawn).toHaveBeenCalledWith(EXEC_PATH, EXPECTED_ARGS, { cwd: ROOT, env: { PATH: "/usr/bin" }, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.emit.stdout("No difference detected.\n");
    child.emit.stderr("warn\n");
    expect(h.kills).toEqual([]);
    child.emit.close(0, null);
    expect(await pending).toEqual({ kind: "exit", code: 0, signal: null, stdout: "No difference detected.\n", stderr: "warn\n", processGroup: "stopped" });
    expect(h.kills).toEqual([[4242, "SIGKILL"]]);
    expect(h.deps.groupExists).toHaveBeenCalledWith(4242);
    expect(h.timers[0].ms).toBe(SCHEMA_DIFF_TIMEOUT_MS);
    expect(h.pending()).toEqual([]);
  });

  it("終了後もグループが残っていれば、間隔をおいて SIGKILL と確認を繰り返す。消えたら stopped", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child, 2);
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS));
    child.emit.close(0, null);
    await Promise.resolve();
    expect(run.state.settled).toBe(false);
    h.fire(SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS);
    h.fire(SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS);
    expect(await run.done).toMatchObject({ kind: "exit", code: 0, processGroup: "stopped" });
    expect(h.kills.filter(([, signal]) => signal === "SIGKILL").length).toBe(3);
  });

  it("終了後、上限（猶予）までにグループが消えなければ not-confirmed（無制限には待たない）", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child, Infinity);
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS));
    child.emit.close(0, null);
    let checks = 0;
    while (!run.state.settled && checks < 1000) {
      h.fire(SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS);
      checks += 1;
      await Promise.resolve();
    }
    expect(await run.done).toMatchObject({ kind: "exit", code: 0, processGroup: "not-confirmed" });
    expect(checks).toBe(SCHEMA_DIFF_KILL_GRACE_MS / SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS);
  });

  it("グループの確認が例外を投げたら「残っている」とみなす（stopped にしない）", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    h.deps.groupExists = vi.fn(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    const capture = createSchemaDiffSpawnCapture(h.deps);
    const run = track(capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS));
    child.emit.close(0, null);
    for (let i = 0; i < 100 && !run.state.settled; i += 1) {
      h.fire(SCHEMA_DIFF_GROUP_CHECK_INTERVAL_MS);
      await Promise.resolve();
    }
    expect(await run.done).toMatchObject({ processGroup: "not-confirmed" });
  });

  it("タイムアウト：グループ（-pgid）に SIGTERM、猶予の後に SIGKILL を送り、終了を待ってから timeout を返す", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS));
    child.emit.stdout("partial");
    h.fire(SCHEMA_DIFF_TIMEOUT_MS);
    expect(h.kills).toEqual([[4242, "SIGTERM"]]);
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    expect(h.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    await Promise.resolve();
    expect(run.state.settled).toBe(false);
    child.emit.close(null, "SIGKILL");
    expect(await run.done).toEqual({ kind: "timeout", stdout: "partial", stderr: "", processGroup: "stopped" });
    expect(h.pending()).toEqual([]);
  });

  it("タイムアウトで SIGKILL を送っても CLI が終わらなければ、さらに猶予の後に not-confirmed で返す（無制限には待たない）", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS));
    h.fire(SCHEMA_DIFF_TIMEOUT_MS);
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    await Promise.resolve();
    expect(run.state.settled).toBe(false);
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    expect(await run.done).toEqual({ kind: "timeout", stdout: "", stderr: "", processGroup: "not-confirmed" });
    // 返した後に close が来ても、結果は変わらない
    child.emit.close(null, "SIGKILL");
  });

  it("グループへのシグナルの送信が失敗しても（ESRCH など）、例外にせず終了を待つ", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    h.deps.killGroup = vi.fn(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    const capture = createSchemaDiffSpawnCapture(h.deps);
    const pending = capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS);
    h.fire(SCHEMA_DIFF_TIMEOUT_MS);
    child.emit.close(null, "SIGTERM");
    expect(await pending).toEqual({ kind: "timeout", stdout: "", stderr: "", processGroup: "stopped" });
  });

  it("起動できない（spawn の例外・pid がないまま error）は spawn-error（コードだけ）。タイマーを置かない", async () => {
    const thrown = processHarness(Object.assign(new Error(`spawn ${RO_URL}`), { code: "EACCES" }));
    expect(await thrown.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS)).toEqual({ kind: "spawn-error", errorCode: "EACCES" });
    expect(thrown.timers).toEqual([]);
    const child = fakeChild(undefined);
    const noPid = processHarness(child);
    const pending = noPid.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS);
    child.emit.error(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(await pending).toEqual({ kind: "spawn-error", errorCode: "ENOENT" });
    expect(noPid.timers).toEqual([]);
    expect(noPid.kills).toEqual([]);
  });

  it("shell・detached の指定が固定値でなければ、起動しない", async () => {
    const h = processHarness(fakeChild(1234));
    expect(await h.capture(EXEC_PATH, EXPECTED_ARGS, { ...OPTIONS, detached: false } as never)).toEqual({ kind: "spawn-error", errorCode: "OPTIONS_REJECTED" });
    expect(await h.capture(EXEC_PATH, EXPECTED_ARGS, { ...OPTIONS, shell: true } as never)).toEqual({ kind: "spawn-error", errorCode: "OPTIONS_REJECTED" });
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });

  it("受け取る出力の量に上限がある", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const pending = h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS);
    for (let i = 0; i < 100; i += 1) child.emit.stderr("x".repeat(4096));
    child.emit.close(1, null);
    const result = await pending;
    expect(result.kind === "exit" && result.stderr.length).toBeLessThan(SCHEMA_DIFF_MAX_CAPTURE + 4097);
  });
});

describe("中断（親のプロセスへの SIGINT・SIGTERM）での CLI のプロセスグループの後始末", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("%s：グループに SIGTERM、猶予の後に SIGKILL を送り、CLI の終了とグループの消滅を確かめてから interrupted を返す", async (signal) => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const interrupts = fakeInterrupts();
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts));
    child.emit.stdout("partial");
    interrupts.fire(signal);
    expect(h.kills).toEqual([[4242, "SIGTERM"]]);
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    expect(h.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    await Promise.resolve();
    expect(run.state.settled).toBe(false);
    child.emit.close(null, "SIGKILL");
    expect(await run.done).toEqual({ kind: "interrupted", signal, stdout: "partial", stderr: "", processGroup: "stopped" });
    // タイムアウトのタイマーも消え、購読も解除される
    expect(h.pending()).toEqual([]);
    expect(interrupts.listenerCount()).toBe(0);
  });

  it("SIGTERM の猶予の間に CLI が終われば、SIGKILL の予定を消し、終了後の確認だけをする", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const interrupts = fakeInterrupts();
    const pending = h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts);
    interrupts.fire("SIGINT");
    child.emit.close(null, "SIGTERM");
    expect(await pending).toMatchObject({ kind: "interrupted", signal: "SIGINT", processGroup: "stopped" });
    expect(h.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(h.pending()).toEqual([]);
  });

  it("SIGKILL の後も CLI が終わらなければ、猶予の後に not-confirmed で返す。購読を残し、force で再び SIGKILL を送れる", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const interrupts = fakeInterrupts();
    const run = track(h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts));
    interrupts.fire("SIGINT");
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    h.fire(SCHEMA_DIFF_KILL_GRACE_MS);
    expect(await run.done).toEqual({ kind: "interrupted", signal: "SIGINT", stdout: "", stderr: "", processGroup: "not-confirmed" });
    expect(interrupts.listenerCount()).toBe(1);
    interrupts.fire("SIGINT", true);
    expect(h.kills.at(-1)).toEqual([4242, "SIGKILL"]);
  });

  it("force（2回目の中断・上限超え）では、すぐにグループに SIGKILL を送る", () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const interrupts = fakeInterrupts();
    void h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts);
    interrupts.fire("SIGINT");
    interrupts.fire("SIGINT", true);
    expect(h.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });

  it("タイムアウトの停止中に中断を受けても、停止を最初からやり直さない（SIGTERM を重ねない）", async () => {
    const child = fakeChild(4242);
    const h = processHarness(child);
    const interrupts = fakeInterrupts();
    const pending = h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts);
    h.fire(SCHEMA_DIFF_TIMEOUT_MS);
    interrupts.fire("SIGINT");
    expect(h.kills).toEqual([[4242, "SIGTERM"]]);
    child.emit.close(null, "SIGTERM");
    expect(await pending).toMatchObject({ kind: "timeout", processGroup: "stopped" });
  });

  it("起動の前に中断を受けていたら、起動しない（spawn-error: INTERRUPTED）", async () => {
    const h = processHarness(fakeChild(4242));
    const interrupts = fakeInterrupts();
    interrupts.fire("SIGTERM");
    expect(await h.capture(EXEC_PATH, EXPECTED_ARGS, OPTIONS, interrupts)).toEqual({ kind: "spawn-error", errorCode: "INTERRUPTED" });
    expect(h.deps.spawn).not.toHaveBeenCalled();
    expect(h.timers).toEqual([]);
  });

  it("中断を渡さなければ（NO_SCHEMA_DIFF_INTERRUPTS）、中断の通知を受けない", () => {
    expect(NO_SCHEMA_DIFF_INTERRUPTS.received()).toBeUndefined();
    expect(Object.isFrozen(NO_SCHEMA_DIFF_INTERRUPTS)).toBe(true);
  });
});

function controllerHarness() {
  const handlers = new Map<string, () => void>();
  const timers: FakeTimer[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const controller = createSchemaDiffInterruptController({
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
    },
    forceExit: (code) => {
      exits.push(code);
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    log: (text) => {
      logs.push(text);
    },
    deadlineMs: SCHEMA_DIFF_INTERRUPT_DEADLINE_MS,
  });
  return { controller, handlers, timers, logs, exits };
}

describe("中断の受け付け（createSchemaDiffInterruptController）", () => {
  it("SIGINT・SIGTERM の両方にハンドラを登録する", () => {
    const h = controllerHarness();
    expect([...h.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    expect(h.controller.received()).toBeUndefined();
  });

  it("1回目：記録して通知する（force ではない）。終了はしない。上限のタイマーを置く", () => {
    const h = controllerHarness();
    const events: SchemaDiffInterruptEvent[] = [];
    h.controller.subscribe((event) => events.push(event));
    h.handlers.get("SIGTERM")?.();
    expect(h.controller.received()).toBe("SIGTERM");
    expect(events).toEqual([{ signal: "SIGTERM", force: false }]);
    expect(h.exits).toEqual([]);
    expect(h.timers.map((t) => t.ms)).toEqual([SCHEMA_DIFF_INTERRUPT_DEADLINE_MS]);
    expect(h.logs.join("\n")).toContain('not "no difference"');
  });

  it("2回目の中断：force を通知してから、終了コード 1 で終了する。最初のシグナルは変わらない", () => {
    const h = controllerHarness();
    const events: SchemaDiffInterruptEvent[] = [];
    h.controller.subscribe((event) => events.push(event));
    h.handlers.get("SIGINT")?.();
    h.handlers.get("SIGTERM")?.();
    expect(events).toEqual([
      { signal: "SIGINT", force: false },
      { signal: "SIGTERM", force: true },
    ]);
    expect(h.exits).toEqual([1]);
    expect(h.controller.received()).toBe("SIGINT");
    expect(h.logs.join("\n")).toContain("not guaranteed that the database is unchanged");
    // 3回目以降と上限のタイマーでは、重ねて終了しない
    h.handlers.get("SIGINT")?.();
    h.timers[0].fn();
    expect(h.exits).toEqual([1]);
  });

  it("上限を超えたら：force を通知し、終了コード 1 で終了する（中断の処理が無制限に止まらない）", () => {
    const h = controllerHarness();
    const events: SchemaDiffInterruptEvent[] = [];
    h.controller.subscribe((event) => events.push(event));
    h.handlers.get("SIGINT")?.();
    h.timers[0].fn();
    expect(events.at(-1)).toEqual({ signal: "SIGINT", force: true });
    expect(h.exits).toEqual([1]);
  });

  it("後始末の1つが例外を投げても、ほかの後始末と終了を止めない。解除した購読には通知しない", () => {
    const h = controllerHarness();
    const seen: string[] = [];
    h.controller.subscribe(() => {
      throw new Error("boom");
    });
    const off = h.controller.subscribe(() => seen.push("removed"));
    h.controller.subscribe((event) => seen.push(event.force ? "force" : "first"));
    off();
    h.handlers.get("SIGINT")?.();
    h.handlers.get("SIGINT")?.();
    expect(seen).toEqual(["first", "force"]);
    expect(h.exits).toEqual([1]);
  });

  it("表示に URL・パスワードを含めない", () => {
    const h = controllerHarness();
    h.handlers.get("SIGINT")?.();
    h.handlers.get("SIGINT")?.();
    const text = h.logs.join("\n");
    expect(text).not.toMatch(/postgres(ql)?:/i);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });
});

describe("ゲート・比較の範囲・定数", () => {
  it("固定のゲート SCHEMA_DIFF_DISABLED は凍結された無効値で、migration 用とは別の値", () => {
    expect(SCHEMA_DIFF_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(SCHEMA_DIFF_DISABLED)).toBe(true);
    expect(SCHEMA_DIFF_DISABLED).not.toBe(LIVE_DATABASE_DISABLED);
  });

  it("比較の範囲の注記：終了コード 0 は「Prisma が比較できる範囲で差分なし」で、_prisma_migrations の除外・比較しない項目・未確認の項目を含む", () => {
    const text = SCHEMA_DIFF_SCOPE_NOTE.join("\n");
    expect(text).toContain("no difference within what Prisma compares");
    expect(text).toContain("_prisma_migrations");
    for (const word of ["column order", "collation", "CHECK/EXCLUDE", "partial index", "INCLUDE", "NULLS NOT DISTINCT", "DEFERRABLE", "unconfirmed"]) expect(text).toContain(word);
  });

  it("katana_test_ro の認証情報のファイル名は、読み取り専用ロールの準備と同じ", () => {
    expect(READ_ONLY_TEST_ENV_FILE).toBe(READ_ONLY_ROLE_ENV_FILE);
  });
});

describe("静的な確認（ソース）", () => {
  it("本体のモジュールは DB ドライバ・Prisma Client・child_process・Docker を読み込まず、ファイルに書き込まない", () => {
    for (const file of ["lib/testing/schemaDiff.ts", "lib/testing/testDbSchemaDiffRunner.ts"]) {
      const source = code(file);
      for (const forbidden of ['from "pg"', "@prisma/client", "@/lib/prisma", "testDbConnection", "child_process", "testDbDocker", "runDockerCommand", "writeFile", "appendFile", "rmSync", "unlink", "mkdir"]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
      expect(source).not.toMatch(/shell:\s*true/);
    }
  });

  it("13. スクリプトは固定のゲート SCHEMA_DIFF_DISABLED を渡す（Step 3-12B-5E-9A-9-8A で最終的に無効に戻した）。引数・環境変数から決めない。runner は承認済みの固定の文字列との一致だけで判定する", () => {
    // 実際の access の設定を構文木で確かめる（コメントの中の文字列は数えない）
    const source = readFileSync(path.join(REPO_ROOT, "scripts/testdb-schema-diff.mts"), "utf8");
    const file = ts.createSourceFile("testdb-schema-diff.mts", source, ts.ScriptTarget.Latest, true);
    const nameOf = (node: ts.ObjectLiteralElementLike) => (node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined);
    const runnerCalls: ts.CallExpression[] = [];
    const accessProperties: ts.ObjectLiteralElementLike[] = [];
    const disabledIdentifiers: ts.Identifier[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runTestDbSchemaDiff") runnerCalls.push(node);
      if (ts.isObjectLiteralElementLike(node) && nameOf(node) === "access") accessProperties.push(node);
      if (ts.isIdentifier(node) && node.text === "SCHEMA_DIFF_DISABLED") disabledIdentifiers.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    // runner の呼び出しは1つだけで、引数はオブジェクトリテラル1つ（スプレッドで access を上書きできない）
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].arguments).toHaveLength(1);
    const options = runnerCalls[0].arguments[0];
    if (!ts.isObjectLiteralExpression(options)) throw new Error("the runner options must be an object literal");
    expect(options.properties.filter(ts.isSpreadAssignment)).toHaveLength(0);
    // access の設定は、ファイル全体でこの1か所だけ
    const access = options.properties.filter((p) => nameOf(p) === "access");
    expect(access).toHaveLength(1);
    expect(accessProperties).toEqual(access);
    // 値は識別子 SCHEMA_DIFF_DISABLED そのもの（オブジェクトリテラル・式・型の変換・条件ではない）
    const [accessProperty] = access;
    if (!ts.isPropertyAssignment(accessProperty)) throw new Error("access must be a plain property assignment");
    const value = accessProperty.initializer;
    if (!ts.isIdentifier(value)) throw new Error("access must be the SCHEMA_DIFF_DISABLED identifier");
    expect(value.text).toBe("SCHEMA_DIFF_DISABLED");
    // SCHEMA_DIFF_DISABLED は lib/testing/schemaDiff.ts から別名なしで import したもの。出現は import と access の2か所だけ（同名の宣言で置き換えられない）
    const importSpecifiers = file.statements
      .filter(ts.isImportDeclaration)
      .filter((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === "../lib/testing/schemaDiff.ts")
      .flatMap((d) => (d.importClause?.namedBindings && ts.isNamedImports(d.importClause.namedBindings) ? [...d.importClause.namedBindings.elements] : []))
      .filter((e) => e.name.text === "SCHEMA_DIFF_DISABLED");
    expect(importSpecifiers).toHaveLength(1);
    expect(importSpecifiers[0].propertyName).toBeUndefined();
    expect(importSpecifiers[0].isTypeOnly).toBe(false);
    expect(disabledIdentifiers).toHaveLength(2);
    expect(disabledIdentifiers).toContain(importSpecifiers[0].name);
    expect(disabledIdentifiers).toContain(value);
    // 有効の値は、スクリプトのコードのどこにもない
    const script = code("scripts/testdb-schema-diff.mts");
    expect(script).toMatch(/^ {2}access: SCHEMA_DIFF_DISABLED,$/m);
    expect(script.match(/SCHEMA_DIFF_DISABLED/g)).toHaveLength(2);
    expect(script).not.toMatch(/enabled-ro-schema-diff/);
    expect(script.match(/process\.argv/g)).toHaveLength(1);
    expect(script.match(/process\.env/g)).toHaveLength(1);
    expect(script).toContain("  argv: process.argv.slice(2),");
    expect(script).toContain("  parentEnv: process.env,");
    const runner = code("lib/testing/testDbSchemaDiffRunner.ts");
    expect(runner).toContain('const gateEnabled = deps.access.mode === "enabled-ro-schema-diff";');
    expect(runner.match(/enabled-ro-schema-diff/g)).toHaveLength(1);
    // migration 用のゲートは、Step 4-8B の一時的な有効化（固定のリテラル）だけ。ほかの固定のゲート（checksum・catalog・ro-role の作成と補完）は無効のまま
    expect(code("scripts/testdb-migrate.mts")).toMatch(/^ {2}liveDatabase: \{ mode: "enabled" \},$/m); // Step 4-8B：テストDB の復旧のために一時的に有効（固定のリテラル。migrate --apply の1回の後、LIVE_DATABASE_DISABLED に戻す）
    expect(code("scripts/testdb-checksums.mts")).toMatch(/^ {2}checksumDatabase: CHECKSUM_DATABASE_DISABLED,$/m);
    expect(code("scripts/testdb-catalog.mts")).toMatch(/^ {2}catalogDatabase: CATALOG_AUDIT_DATABASE_DISABLED,$/m);
    expect(code("scripts/testdb-ro-role.mts")).toMatch(/^ {2}createGate: RO_ROLE_CREATE_DISABLED,$/m);
    expect(code("scripts/testdb-ro-role.mts")).toMatch(/^ {2}grantSyncGate: RO_ROLE_GRANT_SYNC_DISABLED,$/m);
  });

  it("スクリプトの起動は shell なし・detached・プロセスグループへのシグナル（-pgid）だけ", () => {
    const script = code("scripts/testdb-schema-diff.mts");
    expect(script).toContain("spawn: (command, args, options) => spawn(command, args, { ...options, env: options.env as NodeJS.ProcessEnv }),");
    expect(script).toContain("process.kill(-pgid, signal);");
    expect(script).not.toMatch(/execSync|exec\(|execFile|shell: true/);
  });

  it("14. npm のスクリプトは予行の1つだけ（--live 付きはない）。migration・統合テスト・開発用の経路と prisma.config.ts からは呼ばない", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["testdb:schema-diff"]).toBe("node scripts/testdb-schema-diff.mts");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("testdb-schema-diff"))).toHaveLength(1);
    expect(Object.values(pkg.scripts).some((s) => s.includes("--live"))).toBe(false);
    expect(Object.values(pkg.scripts).some((s) => /migrate diff|schemadiff\.config/.test(s))).toBe(false);
    for (const file of ["scripts/testdb-migrate.mts", "scripts/testdb.mts", "scripts/test-integration.mts", "lib/testing/testDbMigrate.ts", "lib/testing/integrationGlobalSetup.ts", "prisma.config.ts", "lib/prisma.ts"]) {
      // testDbMigrate.ts・testDbState.ts には、状態 C の schemaDiff: "not-verified" という既存のフィールド名がある。import だけを調べる
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8"), file).not.toMatch(/["'][^"']*\/(schemaDiff|testDbSchemaDiffRunner)(\.ts)?["']/);
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8"), file).not.toContain("schemadiff.config");
    }
  });
});
