import { TriangleAlert, Upload } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { formatJstDateTime } from "@/lib/dashboard/format";
import { describeImportResult } from "@/lib/dashboard/importStatus";
import { getRecentImportJobs, RECENT_IMPORT_LIMIT, type RecentImportJob } from "@/lib/dashboard/recentImports";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ImportStatusBadge } from "./ImportStatusBadge";

function ImportLink() {
  return (
    <Button asChild variant="outline">
      <Link href="/dashboard/import">
        <Upload className="mr-2 h-4 w-4" />
        ファイル取り込みへ
      </Link>
    </Button>
  );
}

function FileNameLink({ job }: { job: RecentImportJob }) {
  // ファイル名は省略せず折り返して全文を表示する。Reactがテキストとしてエスケープする。
  return (
    <Link
      href={`/dashboard/import/${job.id}`}
      className="focus-visible:ring-ring/50 rounded-sm font-medium break-all underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
    >
      {job.fileName}
    </Link>
  );
}

function CompletedAt({ job }: { job: RecentImportJob }) {
  const completedAt = formatJstDateTime(job.completedAt);
  if (!completedAt) return null;
  return <p className="text-muted-foreground mt-1 text-xs">処理終了 {completedAt}</p>;
}

function ResultText({ job }: { job: RecentImportJob }) {
  const result = describeImportResult(job);
  return (
    <>
      <p>{result.primary}</p>
      {result.secondary && <p className="text-muted-foreground text-xs">{result.secondary}</p>}
    </>
  );
}

type RecentImportsSectionProps = {
  /** server-sideのsession.user.shopId。URLやClientからは受け取らない */
  shopId: string;
};

/**
 * 最近のファイル取り込み（自店のみ・最新5件）。
 * 非同期のServer Componentとして自身で取得するため、page側のSuspense境界内で
 * fallback（RecentImportsSkeleton）が表示され、市場KPIやチャートの表示を待たせない。
 * 取得エラーはcatchせずthrowし、SectionErrorBoundaryで0件とは別の表示にする。
 */
export async function RecentImportsSection({ shopId }: RecentImportsSectionProps) {
  const jobs = await getRecentImportJobs(shopId);

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="font-medium">まだファイルの取り込み履歴がありません。</p>
          <ImportLink />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="hidden md:block">
        <CardContent>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">アップロード日時</TableHead>
                <TableHead>ファイル名</TableHead>
                <TableHead className="w-44">状態</TableHead>
                <TableHead className="w-72">結果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="align-top tabular-nums">
                    {formatJstDateTime(job.createdAt) ?? "—"}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <FileNameLink job={job} />
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <ImportStatusBadge status={job.status} />
                    <CompletedAt job={job} />
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <ResultText job={job} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ul className="space-y-3 md:hidden">
        {jobs.map((job) => (
          <li key={job.id}>
            <Card>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs tabular-nums">
                    アップロード {formatJstDateTime(job.createdAt) ?? "—"}
                  </p>
                  <ImportStatusBadge status={job.status} />
                </div>
                <p>
                  <FileNameLink job={job} />
                </p>
                <div>
                  <ResultText job={job} />
                  <CompletedAt job={job} />
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <ImportLink />
    </div>
  );
}

/** 実際の履歴（5行）に近い高さを確保するfallback。 */
export function RecentImportsSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3" role="status" aria-label="取り込み履歴を読み込んでいます">
        {Array.from({ length: RECENT_IMPORT_LIMIT }, (_, i) => (
          <div key={i} className="bg-muted h-12 animate-pulse rounded-md" />
        ))}
      </CardContent>
    </Card>
  );
}

/** 取得エラー時の表示。0件（Empty State）と区別し、内部情報は出さない。 */
export function RecentImportsError() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-6 text-center" role="alert">
        <TriangleAlert className="text-destructive h-5 w-5" aria-hidden="true" />
        <div>
          <p className="font-medium">取り込み履歴を読み込めませんでした。</p>
          <p className="text-muted-foreground text-sm">
            履歴が無いわけではありません。時間をおいてページを再読み込みしてください。
          </p>
        </div>
        <ImportLink />
      </CardContent>
    </Card>
  );
}
