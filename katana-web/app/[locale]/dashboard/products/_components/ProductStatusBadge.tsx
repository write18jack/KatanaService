import { Badge } from "@/components/ui/badge";

type ProductStatusBadgeProps = {
  status: string;
};

export default function ProductStatusBadge({
  status,
}: ProductStatusBadgeProps) {
  switch (status) {
    case "ON_SALE":
      return <Badge>販売中</Badge>;

    case "SOLD":
      return <Badge variant="secondary">売約済</Badge>;

    case "RESERVED":
      return <Badge variant="outline">商談中</Badge>;

    default:
      return <Badge variant="destructive">不明</Badge>;
  }
}
