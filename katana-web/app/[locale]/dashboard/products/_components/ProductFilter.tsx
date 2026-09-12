"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ProductFilterProps = {
  status: string;
  category: string;
  period: string;
  onStatusChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onPeriodChange: (value: string) => void;
};

export default function ProductFilter({
  status,
  category,
  period,
  onStatusChange,
  onCategoryChange,
  onPeriodChange,
}: ProductFilterProps) {
  return (
    <div className="flex flex-wrap gap-4">
      <Select value={status} onValueChange={onStatusChange}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="在庫状態" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">すべて</SelectItem>
          <SelectItem value="ON_SALE">販売中</SelectItem>
          <SelectItem value="RESERVED">商談中</SelectItem>
          <SelectItem value="SOLD">売約済</SelectItem>
        </SelectContent>
      </Select>

      <Select value={category} onValueChange={onCategoryChange}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="刀種" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">すべて</SelectItem>
          <SelectItem value="KATANA">刀</SelectItem>
          <SelectItem value="WAKIZASHI">脇差</SelectItem>
          <SelectItem value="TANTO">短刀</SelectItem>
          <SelectItem value="NAGINATA">薙刀</SelectItem>
        </SelectContent>
      </Select>

      <Select value={period} onValueChange={onPeriodChange}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="時代" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">すべて</SelectItem>
          <SelectItem value="HEIAN">平安</SelectItem>
          <SelectItem value="KAMAKURA">鎌倉</SelectItem>
          <SelectItem value="MUROMACHI">室町</SelectItem>
          <SelectItem value="EDO">江戸</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
