import { beforeEach, describe, expect, it, vi } from "vitest";

// pg は factory 付きの vi.mock で置き換える（本物の pg は読み込まず、ネットワークにも接続しない）
const fake = vi.hoisted(() => {
  const state = {
    constructed: [] as Record<string, unknown>[],
    calls: [] as string[],
    failConnect: false,
    failEnd: false,
  };
  class Client {
    constructor(config: Record<string, unknown>) {
      state.constructed.push(config);
    }
    async connect() {
      state.calls.push("connect");
      if (state.failConnect) throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    }
    async query(sql: string, params?: unknown[]) {
      state.calls.push(`query ${sql}${params === undefined ? "" : ` ${JSON.stringify(params)}`}`);
      return { rows: [{ ok: true }], rowCount: 1, command: "SELECT" };
    }
    async end() {
      state.calls.push("end");
      if (state.failEnd) throw new Error("end failed");
    }
  }
  return { state, Client };
});

vi.mock("pg", () => ({ default: { Client: fake.Client } }));

const URL = "postgresql://katana_test_user:dummy-pass@127.0.0.1:5434/katana_test";

beforeEach(() => {
  fake.state.constructed.length = 0;
  fake.state.calls.length = 0;
  fake.state.failConnect = false;
  fake.state.failEnd = false;
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
    expect(fake.state.calls).toEqual(["connect", "query SELECT 1", 'query SELECT $1 ["x"]', "end"]);
  });

  it("接続に失敗したら、接続を閉じてから元のエラーを投げる（呼び出し側がコードだけを取り出す）", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.failConnect = true;
    await expect(connectTestDatabase(URL)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(fake.state.calls).toEqual(["connect", "end"]);
  });

  it("接続の失敗の後に閉じる処理も失敗したら、接続の失敗のほうを投げる", async () => {
    const { connectTestDatabase } = await import("./testDbConnection");
    fake.state.failConnect = true;
    fake.state.failEnd = true;
    await expect(connectTestDatabase(URL)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
