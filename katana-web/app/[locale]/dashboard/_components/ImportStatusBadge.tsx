import { CircleCheck, CircleHelp, CircleX, Clock, LoaderCircle, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getImportStatusDisplay, type ImportStatusTone } from "@/lib/dashboard/importStatus";
import { cn } from "@/lib/utils";

const TONES: Record<ImportStatusTone, { icon: LucideIcon; className: string }> = {
  pending: {
    icon: Clock,
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  processing: {
    icon: LoaderCircle,
    className: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  completed: {
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  failed: {
    icon: CircleX,
    className: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  },
  unknown: {
    icon: CircleHelp,
    className: "bg-muted text-muted-foreground",
  },
};

/**
 * ImportJobの状態バッジ。色だけに依存しないよう、必ずアイコンとテキストラベルを併記する。
 */
export function ImportStatusBadge({ status }: { status: string }) {
  const { label, tone } = getImportStatusDisplay(status);
  const { icon: Icon, className } = TONES[tone];

  return (
    <Badge className={cn("border-transparent", className)}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}
