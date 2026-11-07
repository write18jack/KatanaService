import { describe, expect, it } from "vitest";
import {
  addressMatchesContainer,
  dockerIdentityChanges,
  EXPECTED_SERVER_PORT,
  isUtcTimestamp,
  parseUtcTimestamp,
  serverDockerMismatches,
  serverIdentityChanges,
  serverIdentityMismatches,
  type TestDatabaseServerIdentity,
  type TestDbDockerIdentity,
} from "./testDbIdentity";

// DB・Docker には接続しない。照合の純粋な関数だけを確かめる（Step 3-11E）
const DOCKER: TestDbDockerIdentity = {
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  startedAt: "2026-11-06T22:46:49.619782389Z",
  restartCount: 0,
  networkId: "c".repeat(64),
  networkIp: "172.18.0.2",
  volumes: ["0df3f60a", "b655b6e4", "katana-web_postgres_data"],
  developmentVolume: ["katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data"],
  portPublishers: ["katana-test-db"],
};
const SERVER: TestDatabaseServerIdentity = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-06T22:46:51.123456Z" };

describe("parseUtcTimestamp", () => {
  it("Docker（ナノ秒）・PostgreSQL（マイクロ秒）・小数なしの UTC の時刻を、ミリ秒に変換する", () => {
    expect(parseUtcTimestamp("2026-11-06T22:46:49.619782389Z")).toBe(Date.UTC(2026, 10, 6, 22, 46, 49, 619));
    expect(parseUtcTimestamp("2026-11-06T22:46:51.123456Z")).toBe(Date.UTC(2026, 10, 6, 22, 46, 51, 123));
    expect(parseUtcTimestamp("2026-11-06T22:46:51Z")).toBe(Date.UTC(2026, 10, 6, 22, 46, 51, 0));
    expect(isUtcTimestamp("2026-11-06T22:46:51.1Z")).toBe(true);
  });

  it.each(["", "2026-11-06 22:46:51", "2026-11-06T22:46:51+09:00", "2026-11-06T22:46:51.1234567890Z", "not a time", 0, null])("%j は時刻として扱わない", (value) => {
    expect(isUtcTimestamp(value)).toBe(false);
  });
});

describe("serverIdentityMismatches（DB 側だけで分かる不一致）", () => {
  it(`inet_server_port() は ${EXPECTED_SERVER_PORT}（コンテナの中のポート）。公開ポート 5434 ではない`, () => {
    expect(serverIdentityMismatches(SERVER)).toEqual([]);
    expect(serverIdentityMismatches({ ...SERVER, serverPort: 5434 })).toEqual(["server port is not 5432"]);
    expect(serverIdentityMismatches({ ...SERVER, serverPort: 5433 })).toEqual(["server port is not 5432"]);
  });
});

describe("serverIdentityChanges（migration の前後で、同じサーバーのプロセスか）", () => {
  it("3つの値が完全に一致すれば、変化なし", () => {
    expect(serverIdentityChanges(SERVER, { ...SERVER })).toEqual([]);
  });

  it.each<[keyof TestDatabaseServerIdentity, string | number]>([
    ["serverAddress", "172.18.0.3"],
    ["serverPort", 5433],
    ["postmasterStartTime", "2026-11-06T22:46:51.123457Z"],
  ])("%s が変われば検出する（サーバーの再起動・入れ替わり）", (key, value) => {
    expect(serverIdentityChanges(SERVER, { ...SERVER, [key]: value })).toEqual([key]);
  });
});

describe("dockerIdentityChanges（読んだ時点の間で、同じコンテナか）", () => {
  it("すべて一致すれば、変化なし", () => {
    expect(dockerIdentityChanges(DOCKER, structuredClone(DOCKER))).toEqual([]);
  });

  it.each<[keyof TestDbDockerIdentity, unknown]>([
    ["containerId", "d".repeat(64)],
    ["imageId", `sha256:${"e".repeat(64)}`],
    ["startedAt", "2026-11-06T23:00:00.000000000Z"],
    ["restartCount", 1],
    ["networkId", "f".repeat(64)],
    ["networkIp", "172.18.0.9"],
    ["volumes", [...DOCKER.volumes, "anonymous-new"]],
    ["developmentVolume", ["katana-web_postgres_data\t2026-11-07T00:00:00Z\tkatana-web\tpostgres_data"]],
    ["portPublishers", ["katana-test-db", "other"]],
  ])("%s が変われば検出する", (key, value) => {
    expect(dockerIdentityChanges(DOCKER, { ...DOCKER, [key]: value })).toEqual([key]);
  });

  it("ボリュームが減った場合も検出する", () => {
    expect(dockerIdentityChanges(DOCKER, { ...DOCKER, volumes: DOCKER.volumes.slice(1) })).toEqual(["volumes"]);
  });
});

describe("serverDockerMismatches（DB の起動時刻とコンテナの起動時刻。完全一致は求めない）", () => {
  const at = (offsetMs: number) => new Date(Date.UTC(2026, 10, 6, 22, 46, 49, 619) + offsetMs).toISOString();

  it.each([
    ["2秒後（初期化の後に本来のサーバーが起動）", 2_000],
    ["同時", 0],
    ["4秒前（時計の丸め・ずれの範囲）", -4_000],
    ["120秒後（上限）", 120_000],
  ])("%s なら一致とみなす", (_label, offset) => {
    expect(serverDockerMismatches({ ...SERVER, postmasterStartTime: at(offset) }, DOCKER)).toEqual([]);
  });

  it.each([
    ["6秒前（コンテナより前に起動したサーバー＝別のサーバー）", -6_000],
    ["121秒後（コンテナの中でサーバーが起動し直した、または別のサーバー）", 121_000],
    ["1日後", 86_400_000],
  ])("%s なら不一致", (_label, offset) => {
    expect(serverDockerMismatches({ ...SERVER, postmasterStartTime: at(offset) }, DOCKER)).toEqual([
      "postmaster start time is outside the container start window",
    ]);
  });

  it("時刻が読めなければ不一致（安全側）", () => {
    expect(serverDockerMismatches({ ...SERVER, postmasterStartTime: "broken" }, DOCKER)).toEqual(["start time unreadable"]);
    expect(serverDockerMismatches(SERVER, { ...DOCKER, startedAt: "broken" })).toEqual(["start time unreadable"]);
  });

  it("inet_server_addr() とコンテナの IP の一致は、判定に使わない（記録だけ）", () => {
    expect(serverDockerMismatches({ ...SERVER, serverAddress: "10.0.0.5" }, DOCKER)).toEqual([]);
    expect(addressMatchesContainer(SERVER, DOCKER)).toBe(true);
    expect(addressMatchesContainer({ ...SERVER, serverAddress: "10.0.0.5" }, DOCKER)).toBe(false);
  });
});
