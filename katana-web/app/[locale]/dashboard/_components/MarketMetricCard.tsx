import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type MarketMetricCardProps = {
  label: string;
  value: string;
  description?: string;
};

/**
 * 市場KPI・自店サマリーで共通利用するカード。
 * 指標ごとに別ファイルへ分割せず、label/value/descriptionの差し替えで対応する。
 */
export function MarketMetricCard({ label, value, description }: MarketMetricCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-muted-foreground text-sm font-normal">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold">{value}</p>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </CardContent>
    </Card>
  );
}
