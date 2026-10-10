"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatYen } from "@/lib/dashboard/format";
import { formatYenAxis, type PriceTrendChartPoint } from "@/lib/dashboard/priceTrendChart";

const SERIES = [
  { key: "averagePrice", label: "平均価格", color: "var(--series-average)", dash: undefined },
  { key: "medianPrice", label: "中央値", color: "var(--series-median)", dash: "6 4" },
] as const;

type MarketPriceTrendChartProps = {
  data: PriceTrendChartPoint[];
};

function SeriesKey({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="20" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="19" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
}

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: PriceTrendChartPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-sm shadow-md">
      <p className="text-muted-foreground mb-1 text-xs">{point.label}（月末時点）</p>
      <ul className="space-y-0.5">
        {SERIES.map(({ key, label, color, dash }) => (
          <li key={key} className="flex items-center gap-2">
            <SeriesKey color={color} dash={dash} />
            <span className="font-semibold tabular-nums">
              {point[key] === null ? "データなし" : formatYen(point[key])}
            </span>
            <span className="text-muted-foreground text-xs">{label}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1.5 border-t pt-1.5 text-xs">
        在庫 {point.inventoryCount.toLocaleString("ja-JP")}振 ／ 価格公開{" "}
        {point.disclosedPriceCount.toLocaleString("ja-JP")}件
      </p>
    </div>
  );
}

/**
 * 相場推移の折れ線チャート（描画・Tooltip・凡例のみ）。
 * 集計済みの12点をServer Componentから受け取るだけで、データ取得は行わない。
 * 価格nullは欠損値のまま渡し、connectNulls=falseで線を途切れさせる（0円として描画しない）。
 * 系列色はダークモード用に別ステップを指定している（両モードでCVD/コントラスト検証済み）。
 */
export function MarketPriceTrendChart({ data }: MarketPriceTrendChartProps) {
  return (
    <div className="[--series-average:#2a78d6] [--series-median:#eb6834] dark:[--series-average:#3987e5] dark:[--series-median:#d95926]">
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {SERIES.map(({ key, label, color, dash }) => (
          <li key={key} className="flex items-center gap-2">
            <SeriesKey color={color} dash={dash} />
            {label}
          </li>
        ))}
      </ul>

      <div className="h-72 w-full" role="img" aria-label="過去12か月の平均価格と中央値の推移（月末時点）">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickMargin={8}
              interval="preserveStartEnd"
              minTickGap={24}
              padding={{ left: 16, right: 16 }}
            />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickFormatter={formatYenAxis}
              domain={["auto", "auto"]}
            />
            <Tooltip
              content={<TrendTooltip />}
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
              isAnimationActive={false}
            />
            {SERIES.map(({ key, label, color, dash }) => (
              <Line
                key={key}
                type="linear"
                dataKey={key}
                name={label}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={dash}
                strokeLinecap="round"
                strokeLinejoin="round"
                connectNulls={false}
                dot={{ r: 4, fill: color, stroke: "var(--card)", strokeWidth: 2, strokeDasharray: "0" }}
                activeDot={{ r: 5, fill: color, stroke: "var(--card)", strokeWidth: 2, strokeDasharray: "0" }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
