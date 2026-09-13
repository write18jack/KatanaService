"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export default function ProductSort({ value, onChange }: Props) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-52">
        <SelectValue />
      </SelectTrigger>

      <SelectContent>
        <SelectItem value="created_desc">登録日（新しい順）</SelectItem>

        <SelectItem value="created_asc">登録日（古い順）</SelectItem>

        <SelectItem value="price_desc">価格（高い順）</SelectItem>

        <SelectItem value="price_asc">価格（安い順）</SelectItem>

        <SelectItem value="name_asc">銘（A→Z）</SelectItem>

        <SelectItem value="name_desc">銘（Z→A）</SelectItem>
      </SelectContent>
    </Select>
  );
}
