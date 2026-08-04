import { SaleHouse } from "@prisma/client";
import { SaleHouseClient } from "../types";
import { FasigTiptonClient } from "./fasigTipton";
import { KeenelandClient } from "./keeneland";
import { OBSClient } from "./obs";

const clients: Record<SaleHouse, SaleHouseClient> = {
  FASIG_TIPTON: new FasigTiptonClient(),
  KEENELAND: new KeenelandClient(),
  OBS: new OBSClient(),
};

export function clientFor(house: SaleHouse): SaleHouseClient {
  return clients[house];
}
