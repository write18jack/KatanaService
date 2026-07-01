import * as z from "zod";

export const katanaSchema = z.object({
  shopName: z.string().min(1, "店舗名を入力してください"),
  name: z.string().min(1, "銘を入力してください"),
  katanaType: z.enum(["打刀", "脇差", "短刀", "太刀", "薙刀"]),
  era: z.string().min(1, "時代を入力してください"),
  price: z.coerce.number().min(0, "価格は0以上である必要があります"),
});

export type KatanaInput = z.infer<typeof katanaSchema>;
