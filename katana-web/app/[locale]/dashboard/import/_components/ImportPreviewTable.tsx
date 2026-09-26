import type { ImportRow } from "@prisma/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ImportRowStatusBadge from "./ImportRowStatusBadge";

export default function ImportPreviewTable({ rows }: { rows: ImportRow[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>行番号</TableHead>
            <TableHead>商品コード</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>メッセージ</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.rowNumber}</TableCell>
              <TableCell>{row.productCode ?? "—"}</TableCell>
              <TableCell>
                <ImportRowStatusBadge status={row.status} />
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {row.message ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
