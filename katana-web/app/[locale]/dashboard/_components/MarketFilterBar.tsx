"use client";

import { useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { RotateCcw } from "lucide-react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MarketFilters } from "@/lib/market-analytics/types";
import {
  buildFilterHref,
  buildResetSearchParams,
  buildUpdatedSearchParams,
  hasMarketFilterParams,
  MARKET_FILTER_FIELDS,
  type MarketFilterKey,
  type MarketFilterMasterOptions,
} from "@/lib/dashboard/marketFilters";

const ALL_VALUE = "ALL";

type MarketFilterBarProps = {
  masters: MarketFilterMasterOptions;
  filters: MarketFilters;
};

/**
 * 市場フィルターUI（8 Select + リセット）。
 * URL更新のみを責務とし、Market Analytics/Prismaは呼び出さない。
 * 検証・集計はServer Component側（Dashboard page）がURLから再実行する。
 */
export function MarketFilterBar({ masters, filters }: MarketFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function navigate(next: URLSearchParams) {
    // pushで履歴を積み、Browser Back/Forwardでフィルター状態を復元できるようにする。
    // localeの付与はnext-intlのrouterが行う（localePrefix: "always"）。
    startTransition(() => {
      router.push(buildFilterHref(pathname, next), { scroll: false });
    });
  }

  function handleChange(key: MarketFilterKey, value: string) {
    navigate(buildUpdatedSearchParams(searchParams, key, value === ALL_VALUE ? null : value));
  }

  function handleReset() {
    navigate(buildResetSearchParams(searchParams));
  }

  return (
    <div className="bg-muted/30 space-y-4 rounded-lg border p-4" aria-busy={isPending}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {MARKET_FILTER_FIELDS.map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`market-filter-${key}`}>{label}</Label>
            <Select
              value={filters[key] ?? ALL_VALUE}
              onValueChange={(value) => handleChange(key, value)}
              disabled={isPending}
            >
              <SelectTrigger id={`market-filter-${key}`} className="bg-background w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>すべて（指定なし）</SelectItem>
                {masters[key].map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          disabled={isPending || !hasMarketFilterParams(searchParams)}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          条件をリセット
        </Button>
        {isPending && (
          <p className="text-muted-foreground text-sm" role="status">
            集計を更新しています…
          </p>
        )}
      </div>
    </div>
  );
}
