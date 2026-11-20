import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// pg は factory 付きの vi.mock で置き換える（本物の pg は読み込まず、ネットワークにも接続しない）
const fake = vi.hoisted(() => {
  /** 切断（error イベント）を起こす時点。`during` はその SQL の応答の前、`after` は応答の後 */
  type Disconnect = { at: "connect" } | { at: "during" | "after"; sql: string } | { at: "end" };
  const state = {
    constructed: [] as Record<string, unknown>[],
    calls: [] as string[],
    failConnect: false,
    failEnd: false,
    /** ROLLBACK がサーバーのエラーで失敗する（切断ではない） */
    failRollback: false,
    disconnect: undefined as Disconnect | undefined,
    /** error イベントに渡すエラー（生のメッセージに接続URLを含める） */
    disconnectError: undefined as unknown,
    /** SQL ごとの応答。未設定なら [{ ok: true }] */
    rowsFor: undefined as ((sql: string) => Record<string, unknown>[]) | undefined,
    clients: [] as { emit: (event: string, error: unknown) => boolean }[],
  };
  class Client {
    private listeners: ((error: unknown) => void)[] = [];
    constructor(config: Record<string, unknown>) {
      state.constructed.push(config);
      state.clients.push(this);
    }
    on(event: string, listener: (error: unknown) => void) {
      state.calls.push(`on ${event}`);
      if (event === "error") this.listeners.push(listener);
      return this;
    }
    /** EventEmitter と同じく、リスナーがなければ throw する（Node の未処理の例外になる） */
    emit(event: string, error: unknown) {
      if (event !== "error") return false;
      if (this.listeners.length === 0) throw error;
      for (const listener of this.listeners) listener(error);
      return true;
    }
    private lose() {
      state.calls.push("error-event");
      this.emit("error", state.disconnectError);
    }
    async connect() {
      state.calls.push("connect");
      if (state.failConnect) throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
      if (state.disconnect?.at === "connect") this.lose();
    }
    async query(sql: string, params?: unknown[]) {
      state.calls.push(`query ${sql}${params === undefined ? "" : ` ${JSON.stringify(params)}`}`);
      const d = state.disconnect;
      if (d?.at === "during" && sql.includes(d.sql)) {
        // pg と同じく、error イベントの後に、実行中のクエリを生のエラーで失敗させる
        this.lose();
        throw new Error("Connection terminated unexpectedly");
      }
      if (sql === "ROLLBACK" && state.failRollback) throw Object.assign(new Error(`rollback failed at ${URL_IN_FAKE}`), { code: "25P02" });
      const rows = state.rowsFor ? state.rowsFor(sql) : [{ ok: true }];
      if (d?.at === "after" && sql.includes(d.sql)) this.lose();
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    async end() {
      state.calls.push("end");
      if (state.disconnect?.at === "end") this.lose();
      if (state.failEnd) throw new Error("end failed");
    }
  }
  const URL_IN_FAKE = "postgresql://katana_test_user:dummy-pass@127.0.0.1:5434/katana_test";
  return { state, Client };
});

vi.mock("pg", () => ({ default: { Client: fake.Client } }));

const URL = "postgresql://katana_test_user:dummy-pass@127.0.0.1:5434/katana_test";

beforeEach(() => {
  fake.state.constructed.length = 0;
  fake.state.calls.length = 0;
  fake.state.failConnect = false;
  fake.state.failEnd = false;
  fake.state.failRollback = false;
  fake.state.disconnect = undefined;
  fake.state.disconnectError = Object.assign(new Error(`Connection terminated unexpectedly (${URL})`), {});
  fake.state.rowsFor = undefined;
  fake.state.clients.length = 0;
});

describe("connectTestDatabase", () => {
  it("import しただけでは、接続を作らない", async () => {
    const loaded = await import("./testDbConnection");
    expect(typeof loaded.connectTestDatabase).toBe("function");
    expect(fake.state.constructed).toEqual([]);
    expect(fake.state.calls).toEqual([]);
  });

  it("呼んだときに1回だけ接続し、タイムアウトを設定する。query は rows だけを返し、end で閉じる", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    const client = await connectTestDatabase(URL);
    expect(fake.state.constructed).toEqual([
      expect.objectContaining({
        connectionString: URL,
        connectionTimeoutMillis: expect.any(Number),
        query_timeout: expect.any(Number),
        statement_timeout: expect.any(Number),
      }),
    ]);
    await expect(client.query("SELECT 1")).resolves.toEqual({ rows: [{ ok: true }] });
    await client.query("SELECT $1", ["x"]);
    await client.end();
    expect(fake.state.calls).toEqual(["on error", "connect", "query SELECT 1", 'query SELECT $1 ["x"]', "end"]);
  });

  it("接続に失敗したら、接続を閉じてから元のエラーを投げる（呼び出し側がコードだけを取り出す）", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.failConnect = true;
    await expect(connectTestDatabase(URL)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(fake.state.calls).toEqual(["on error", "connect", "end"]);
  });

  it("接続の失敗の後に閉じる処理も失敗したら、接続の失敗のほうを投げる", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.failConnect = true;
    fake.state.failEnd = true;
    await expect(connectTestDatabase(URL)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("connectTestDatabase：予期しない切断（error イベント。Step 3-11C）", () => {
  it("接続を始める前に error のリスナーを登録する（リスナーがないと、偽の Client も本物と同じく throw する）", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    await connectTestDatabase(URL);
    expect(fake.state.calls.indexOf("on error")).toBeLessThan(fake.state.calls.indexOf("connect"));
    // リスナーのない Client で error イベントを出すと throw する（本物の pg・EventEmitter の挙動を偽物でも再現している）
    const bare = new fake.Client({});
    expect(() => bare.emit("error", new Error("x"))).toThrow("x");
  });

  it("接続中に error イベントが届いたら、接続を成功とせず、閉じてからコードだけのエラーを投げる", async () => {
    const { connectTestDatabase, CONNECTION_LOST_CODE } = await import("./testDbConnection");
    fake.state.disconnect = { at: "connect" };
    const error = await connectTestDatabase(URL).catch((e: Error) => e);
    expect(error).toMatchObject({ code: CONNECTION_LOST_CODE });
    expect((error as Error).message).not.toContain("dummy-pass");
    expect((error as Error).message).not.toContain("terminated");
    expect(fake.state.calls).toEqual(["on error", "connect", "error-event", "end"]);
  });

  it("切断の後の query は、ドライバの生のエラーではなく、切断のコードで失敗する（再接続しない）", async () => {
    const { connectTestDatabase, CONNECTION_LOST_CODE } = await import("./testDbConnection");
    fake.state.disconnect = { at: "during", sql: "SELECT 1" };
    const client = await connectTestDatabase(URL);
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: CONNECTION_LOST_CODE, message: "the test database connection was lost." });
    await expect(client.query("SELECT 2")).rejects.toMatchObject({ code: CONNECTION_LOST_CODE });
    await expect(client.end()).rejects.toMatchObject({ code: CONNECTION_LOST_CODE });
    expect(fake.state.constructed).toHaveLength(1);
    expect(fake.state.calls.filter((c) => c === "connect")).toHaveLength(1);
    // 2回目の query はドライバに送らない
    expect(fake.state.calls.filter((c) => c.startsWith("query "))).toEqual(["query SELECT 1"]);
  });

  it("error イベントにコード（SQLSTATE・E…）があれば、そのコードを使う。生のメッセージは使わない", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.disconnect = { at: "during", sql: "SELECT 1" };
    fake.state.disconnectError = Object.assign(new Error(`terminating connection due to administrator command ${URL}`), { code: "57P01" });
    const client = await connectTestDatabase(URL);
    const error = await client.query("SELECT 1").catch((e: Error) => e);
    expect(error).toMatchObject({ code: "57P01" });
    expect((error as Error).message).not.toContain(URL);
  });

  it("2回目以降の error イベントは、最初のコードを上書きしない", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.disconnect = { at: "during", sql: "SELECT 1" };
    fake.state.disconnectError = Object.assign(new Error("first"), { code: "ECONNRESET" });
    const client = await connectTestDatabase(URL);
    await client.query("SELECT 1").catch(() => undefined);
    fake.state.clients[0].emit("error", Object.assign(new Error("second"), { code: "57P01" }));
    await expect(client.query("SELECT 2")).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("end の後に届いた error イベントで、プロセスが止まらない（リスナーを外さない）", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    const client = await connectTestDatabase(URL);
    await client.end();
    expect(() => fake.state.clients[0].emit("error", new Error("late"))).not.toThrow();
  });
});

describe("--verify の判定と connectTestDatabase（偽の pg。実DBには接続しない）", () => {
  const REPO_ROOT = path.resolve(__dirname, "../..");
  const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";

  /** 状態 A の空のDBの応答 */
  const emptyDatabaseRows = (sql: string): Record<string, unknown>[] => {
    if (sql.includes("set_config")) return [{ searchPath: "pg_catalog" }];
    if (sql.includes("has_schema_privilege")) return [{ publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true }];
    if (sql.includes("inet_server_addr")) return [{ serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-06T22:46:51.123456Z" }];
    if (sql.includes("transaction_read_only")) return [{ transaction_read_only: "on" }];
    if (sql.includes("current_database() AS database")) {
      return [{ database: "katana_test", currentUser: "katana_test_user", sessionUser: "katana_test_user", marker: "katana-test-db", serverPort: 5432 }];
    }
    if (sql.includes("pg_catalog.pg_operator")) return [];
    if (sql.includes("pg_catalog.pg_extension")) return [{ name: "plpgsql" }];
    if (sql.includes("pg_catalog.pg_class c") || sql.includes("pg_catalog.pg_type t") || sql.includes("pg_catalog.pg_proc p")) return [];
    if (sql.includes("pg_catalog.pg_namespace n")) return [{ name: "public" }];
    return [];
  };

  async function classify() {
    const { connectTestDatabase } = await import("./testDbConnection");
    const { createTestDatabaseClassifier } = await import("./testDbMigrate");
    fake.state.rowsFor = emptyDatabaseRows;
    const classifier = createTestDatabaseClassifier({ root: REPO_ROOT, connect: connectTestDatabase });
    return classifier({ databaseUrl: URL, developmentDatabaseUrl: DEV_URL });
  }

  /** 判定が失敗し、A として成功しないこと。エラーにはコードだけが入り、接続URL・パスワード・ドライバのメッセージを含まない */
  async function expectFailure(code: string, detail: string) {
    const error = await classify().then(
      (state) => {
        throw new Error(`expected a failure but got state ${state.state}`);
      },
      (e: Error) => e,
    );
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(`(${detail})`);
    for (const secret of [URL, "dummy-pass", "postgresql://", "terminated", "administrator", "rollback failed", "end failed"]) {
      expect(error.message).not.toContain(secret);
    }
    // 再接続しない
    expect(fake.state.constructed).toHaveLength(1);
    expect(fake.state.calls.filter((c) => c === "connect")).toHaveLength(1);
    return error;
  }

  const queriesSent = () => fake.state.calls.filter((c) => c.startsWith("query ")).map((c) => c.slice("query ".length));

  it("正常な接続：A と判定し、BEGIN READ ONLY から ROLLBACK・end まで行う", async () => {
    await expect(classify()).resolves.toEqual({ state: "A" });
    expect(queriesSent()[0]).toBe("BEGIN READ ONLY");
    expect(queriesSent().at(-1)).toBe("ROLLBACK");
    expect(fake.state.calls.at(-1)).toBe("end");
    expect(fake.state.calls).not.toContain("error-event");
  });

  it("接続中の切断：CONNECT_FAILED（クエリを送らない）", async () => {
    fake.state.disconnect = { at: "connect" };
    await expectFailure("CONNECT_FAILED", "ECONNLOST");
    expect(queriesSent()).toEqual([]);
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("BEGIN の実行中の切断：QUERY_FAILED（BEGIN が終わっていないので ROLLBACK は送らず、接続は閉じる）", async () => {
    fake.state.disconnect = { at: "during", sql: "BEGIN READ ONLY" };
    await expectFailure("QUERY_FAILED", "ECONNLOST");
    expect(queriesSent()).toEqual(["BEGIN READ ONLY"]);
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("BEGIN の直後の切断：search_path の固定に進まず QUERY_FAILED（ROLLBACK はドライバに送れないので送らない）", async () => {
    fake.state.disconnect = { at: "after", sql: "BEGIN READ ONLY" };
    await expectFailure("QUERY_FAILED", "ECONNLOST");
    expect(queriesSent()).toEqual(["BEGIN READ ONLY"]);
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("カタログの検査中の切断：QUERY_FAILED（状態を返さない）", async () => {
    fake.state.disconnect = { at: "during", sql: "pg_catalog.pg_class c" };
    const error = await expectFailure("QUERY_FAILED", "ECONNLOST");
    expect(error.message).toContain("relation listing failed");
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("A と判定した後、ROLLBACK の前の切断：ROLLBACK が失敗し、A として成功しない", async () => {
    fake.state.disconnect = { at: "after", sql: "pg_catalog.pg_operator" };
    await expectFailure("QUERY_FAILED", "ECONNLOST");
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("ROLLBACK の後、接続の解放の前の切断：CLOSE_FAILED で、A として成功しない", async () => {
    fake.state.disconnect = { at: "after", sql: "ROLLBACK" };
    const error = await expectFailure("CLOSE_FAILED", "ECONNLOST");
    expect(error.message).toContain("the connection could not be closed");
  });

  it("接続の解放の最中の切断：CLOSE_FAILED", async () => {
    fake.state.disconnect = { at: "end" };
    await expectFailure("CLOSE_FAILED", "ECONNLOST");
  });

  it("ROLLBACK の失敗（サーバーのエラー）：QUERY_FAILED（SQLSTATE だけ）。接続は閉じる", async () => {
    fake.state.failRollback = true;
    const error = await expectFailure("QUERY_FAILED", "25P02");
    expect(error.message).toContain("ROLLBACK failed");
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("end の失敗：CLOSE_FAILED（コードのないエラーは unknown）", async () => {
    fake.state.failEnd = true;
    await expectFailure("CLOSE_FAILED", "unknown");
  });

  it("複数のエラー：最初の失敗（カタログの検査中の切断）を返し、後の ROLLBACK・end の失敗で上書きしない", async () => {
    fake.state.disconnect = { at: "during", sql: "pg_catalog.pg_class c" };
    fake.state.failEnd = true;
    const error = await expectFailure("QUERY_FAILED", "ECONNLOST");
    expect(error.message).toContain("relation listing failed");
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("--verify の検査（権限・識別情報を含む）で、識別情報の SQL の実行中に切断されたら QUERY_FAILED（状態 A として成功しない）", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    const { createTestDatabaseInspector } = await import("./testDbMigrate");
    fake.state.rowsFor = emptyDatabaseRows;
    fake.state.disconnect = { at: "during", sql: "inet_server_addr" };
    const inspector = createTestDatabaseInspector({ root: REPO_ROOT, connect: connectTestDatabase });
    const error = await inspector({ databaseUrl: URL, developmentDatabaseUrl: DEV_URL }).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "QUERY_FAILED" });
    expect((error as Error).message).toContain("server identity query failed (ECONNLOST)");
    expect((error as Error).message).not.toContain("dummy-pass");
    expect(fake.state.constructed).toHaveLength(1);
    expect(fake.state.calls.at(-1)).toBe("end");
  });

  it("--verify の検査（権限・識別情報を含む）は、正常な接続で A と識別情報を返す", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    const { createTestDatabaseInspector } = await import("./testDbMigrate");
    fake.state.rowsFor = emptyDatabaseRows;
    const inspector = createTestDatabaseInspector({ root: REPO_ROOT, connect: connectTestDatabase });
    await expect(inspector({ databaseUrl: URL, developmentDatabaseUrl: DEV_URL })).resolves.toMatchObject({
      state: { state: "A" },
      server: { serverPort: 5432 },
    });
  });

  it("サーバーからの切断のコード（57P01）は、そのまま表示し、メッセージは表示しない", async () => {
    fake.state.disconnect = { at: "during", sql: "pg_catalog.pg_class c" };
    fake.state.disconnectError = Object.assign(new Error(`terminating connection due to administrator command ${URL}`), { code: "57P01" });
    await expectFailure("QUERY_FAILED", "57P01");
  });
});
