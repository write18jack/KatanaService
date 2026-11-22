import { describe, expect, it } from "vitest";
import type { MarketTrendPoint } from "@/lib/market-analytics/types";
import { formatYenAxis, hasAnyPriceData, toPriceTrendChartData } from "./priceTrendChart";
import { getLastCompletedMonthEnds } from "./trendPeriod";

const monthEnds = getLastCompletedMonthEnds(new Date("2026-10-10T03:00:00Z"));
const monthLabels = monthEnds.map((m) => m.label);

function trend(overrides: Record<number, Partial<MarketTrendPoint>> = {}): MarketTrendPoint[] {
  return monthEnds.map((m, i) => ({
    date: m.asOf,
    inventoryCount: 10 + i,
    disclosedPriceCount: 5 + i,
    averagePrice: 1_000_000 + i * 10_000,
    medianPrice: 900_000 + i * 10_000,
    ...overrides[i],
  }));
}

describe("toPriceTrendChartData", () => {
  it("average/median/inventoryCount/disclosedPriceCountを再計算せずそのまま渡す", () => {
    const data = toPriceTrendChartData(trend(), monthLabels);
    expect(data[3]).toEqual({
      label: "2026/01",
      averagePrice: 1_030_000,
      medianPrice: 930_000,
      inventoryCount: 13,
      disclosedPriceCount: 8,
    });
  });

  it("12点の順序（古い月→新しい月）を維持する", () => {
    const data = toPriceTrendChartData(trend(), monthLabels);
    expect(data.map((d) => d.label)).toEqual(monthLabels);
    expect(data).toHaveLength(12);
  });

  it("nullを0へ変換しない（欠損値のまま保持）", () => {
    const data = toPriceTrendChartData(
      trend({ 5: { averagePrice: null, medianPrice: null, disclosedPriceCount: 0 } }),
      monthLabels,
    );
    expect(data[5].averagePrice).toBeNull();
    expect(data[5].medianPrice).toBeNull();
    expect(data[5].inventoryCount).toBe(15);
  });

  it("Dateを含まずシリアライズ可能な値のみを返す", () => {
    const data = toPriceTrendChartData(trend(), monthLabels);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(Object.keys(data[0]).sort()).toEqual(
      ["averagePrice", "disclosedPriceCount", "inventoryCount", "label", "medianPrice"].sort(),
    );
  });
});

describe("hasAnyPriceData", () => {
  const allNull = Object.fromEntries(
    monthEnds.map((_, i) => [i, { averagePrice: null, medianPrice: null, disclosedPriceCount: 0 }]),
  );

  it("全月nullの場合はfalse（Empty State）。在庫があっても価格データなしとして扱う", () => {
    const data = toPriceTrendChartData(trend(allNull), monthLabels);
    expect(data.every((d) => d.inventoryCount > 0)).toBe(true);
    expect(hasAnyPriceData(data)).toBe(false);
  });

  it("一部月のみnullの場合はtrueで、null月は欠損のまま残る（線が途切れる）", () => {
    const data = toPriceTrendChartData(trend({ 4: allNull[4], 5: allNull[5] }), monthLabels);
    expect(hasAnyPriceData(data)).toBe(true);
    expect(data.map((d) => d.averagePrice === null)).toEqual([
      false, false, false, false, true, true, false, false, false, false, false, false,
    ]);
  });
});

describe("formatYenAxis", () => {
  it("万円・億円の短縮表記にする", () => {
    expect(formatYenAxis(1_500_000)).toBe("150万円");
    expect(formatYenAxis(12_000_000)).toBe("1,200万円");
    expect(formatYenAxis(125_000_000)).toBe("1.3億円");
    expect(formatYenAxis(5_000)).toBe("5,000円");
    expect(formatYenAxis(0)).toBe("0円");
  });
});
