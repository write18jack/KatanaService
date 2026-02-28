"use client";

import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// status を持つ最小限の型を定義
interface HasStatus {
  status: string;
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

export function DataTable<TData extends HasStatus, TValue>({
  columns,
  data,
}: DataTableProps<TData, TValue>) {
  // ステータスごとにフィルタリング
  // DataTable が受け取る TData 型が、最低限statusプロパティを
  // 持っていることをTypeScriptに教える
  const pendingRequests = data.filter((d) => d.status === "PENDING");
  const historyRequests = data.filter((d) => d.status !== "PENDING");

  return (
    <Tabs defaultValue="pending" className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="pending">
          承認待ち ({pendingRequests.length})
        </TabsTrigger>
        <TabsTrigger value="history">
          処理済み履歴 ({historyRequests.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="pending">
        {/* TanStack Table のレンダリングロジック（承認待ち用） */}
        <TableContent columns={columns} data={pendingRequests} />
      </TabsContent>

      <TabsContent value="history">
        {/* TanStack Table のレンダリングロジック（履歴用） */}
        <TableContent columns={columns} data={historyRequests} />
      </TabsContent>
    </Tabs>
  );
}

// テーブル描画部分を再利用可能な内部コンポーネントとして定義
function TableContent<TData, TValue>({
  columns,
  data,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                データがありません。
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
