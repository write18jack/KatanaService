/**
 * テストDBの接続先の識別情報（Step 3-11E。TOCTOU の対策）。DBにも Docker にも接続しない、純粋な関数と型だけを置く。
 *
 * - DB 側（TestDatabaseServerIdentity）：読み取り専用のトランザクションの中で、本人確認の後に読む
 *   （lib/testing/testDbState.ts の inspectTestDatabase。inet_server_addr()・inet_server_port()・pg_postmaster_start_time()）。
 * - Docker 側（TestDbDockerIdentity）：読み取り専用の docker コマンドで読む（scripts/testdb.mts の readTestDbDockerIdentity）。
 *
 * どちらも「読んだ時点」の記録で、その後の接続先を固定しない。migration の前後で照合して、入れ替わり・再起動を検出する。
 * Prisma CLI は別のプロセス・別の接続で接続するので、前後の照合だけでは、その接続が同じDBに届くことを完全には保証できない。
 *
 * 照合の方針:
 * - inet_server_port() はコンテナの中のポート（5432）。ホストに公開したポート（5434）とは別で、DB の中からは 5434 を確かめられない。
 * - inet_server_addr() は記録して前後で比べるが、コンテナの IP との一致は必須にしない（Docker Desktop のポート転送の経路に依存するため）。
 * - pg_postmaster_start_time() と Docker の State.StartedAt は完全一致を求めない（初期化の時間の分だけ後になる）。範囲で照合する。
 * - pg_control_system() は使わない（katana_test_user で読める保証がなく、権限を足さない）。
 */

/** コンテナの中で PostgreSQL が待ち受けるポート（docker-compose.test.yml の 127.0.0.1:5434 -> 5432） */
export const EXPECTED_SERVER_PORT = 5432;
/** pg_postmaster_start_time() が StartedAt より前でもよい幅（時計の丸め・ずれの分） */
export const POSTMASTER_START_EARLIEST_MS = 5_000;
/** pg_postmaster_start_time() が StartedAt より後でもよい幅（初期化の時間。ラッパーの up の待ち時間と同じ120秒） */
export const POSTMASTER_START_LATEST_MS = 120_000;

/** DB 側の識別情報（読み取り専用のトランザクションの中で読んだ値） */
export type TestDatabaseServerIdentity = {
  /** inet_server_addr() の host 部分（例：172.18.0.2） */
  serverAddress: string;
  /** inet_server_port()（コンテナの中のポート） */
  serverPort: number;
  /** pg_postmaster_start_time() の UTC の文字列（マイクロ秒まで。例：2026-11-06T22:46:51.123456Z） */
  postmasterStartTime: string;
};

/** Docker 側の識別情報（読み取り専用の docker コマンドで読んだ値）。Config.Env などの秘密情報は含まない */
export type TestDbDockerIdentity = {
  containerId: string;
  imageId: string;
  /** State.StartedAt（Docker の形式のまま。ナノ秒まで） */
  startedAt: string;
  restartCount: number;
  /** Compose の既定のネットワーク（katana-test_default）の ID と、そこでのコンテナの IP */
  networkId: string;
  networkIp: string;
  /** すべてのボリュームの名前（名前順） */
  volumes: string[];
  /** 開発用ボリュームの名前・作成日時・ラベル */
  developmentVolume: string[];
  /** 5434番を公開しているコンテナの名前 */
  portPublishers: string[];
};

const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

/** UTC の時刻の文字列（小数部は9桁まで）をミリ秒に変換する。形が違えば NaN */
export function parseUtcTimestamp(value: string): number {
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`);
}

export function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(parseUtcTimestamp(value));
}

/** DB 側の識別情報だけで分かる不一致（項目名だけを返す） */
export function serverIdentityMismatches(server: TestDatabaseServerIdentity): string[] {
  return server.serverPort === EXPECTED_SERVER_PORT ? [] : [`server port is not ${EXPECTED_SERVER_PORT}`];
}

/** 同じサーバーのプロセスか（migration の前後で、3つの値が完全に一致すること）。違う項目の名前を返す */
export function serverIdentityChanges(before: TestDatabaseServerIdentity, after: TestDatabaseServerIdentity): string[] {
  return (["serverAddress", "serverPort", "postmasterStartTime"] as const).filter((key) => before[key] !== after[key]);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/** 同じコンテナか（読んだ時点の間で変わっていないこと）。違う項目の名前を返す */
export function dockerIdentityChanges(before: TestDbDockerIdentity, after: TestDbDockerIdentity): string[] {
  const changes: string[] = [];
  for (const key of ["containerId", "imageId", "startedAt", "restartCount", "networkId", "networkIp"] as const) {
    if (before[key] !== after[key]) changes.push(key);
  }
  for (const key of ["volumes", "developmentVolume", "portPublishers"] as const) {
    if (!sameList(before[key], after[key])) changes.push(key);
  }
  return changes;
}

/**
 * DB 側と Docker 側の照合。pg_postmaster_start_time() が State.StartedAt の前後の範囲に収まること（完全一致は求めない）。
 * inet_server_addr() とコンテナの IP の一致は、必須にしない（addressMatchesContainer で記録だけする）。
 */
export function serverDockerMismatches(server: TestDatabaseServerIdentity, docker: TestDbDockerIdentity): string[] {
  const started = parseUtcTimestamp(docker.startedAt);
  const postmaster = parseUtcTimestamp(server.postmasterStartTime);
  if (!Number.isFinite(started) || !Number.isFinite(postmaster)) return ["start time unreadable"];
  const offset = postmaster - started;
  return offset >= -POSTMASTER_START_EARLIEST_MS && offset <= POSTMASTER_START_LATEST_MS ? [] : ["postmaster start time is outside the container start window"];
}

/** inet_server_addr() がコンテナの IP と同じか（記録用。判定には使わない） */
export function addressMatchesContainer(server: TestDatabaseServerIdentity, docker: TestDbDockerIdentity): boolean {
  return server.serverAddress === docker.networkIp;
}
