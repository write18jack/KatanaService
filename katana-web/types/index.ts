export type KatanaType = "打刀" | "脇差" | "短刀" | "太刀" | "薙刀";
export type KatanaStatus = "販売中" | "商談中" | "売約済";

export type Katana = {
  id: string;
  name: string; 
  type: KatanaType;
  era: string | null;
  price: number;
  status: KatanaStatus;
  dealerId: string;
  createdAt: Date;
};
