import type { ImportRowStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

const STYLES: Record<ImportRowStatus, string> = {
  SUCCESS: "bg-green-100 text-green-700",
  ERROR: "bg-red-100 text-red-700",
  SKIPPED: "bg-gray-100 text-gray-600",
};

const LABELS: Record<ImportRowStatus, string> = {
  SUCCESS: "成功見込み",
  ERROR: "エラー",
  SKIPPED: "スキップ",
};

export default function ImportRowStatusBadge({ status }: { status: ImportRowStatus }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STYLES[status])}>
      {LABELS[status]}
    </span>
  );
}
