import { BigInt } from "@graphprotocol/graph-ts";

import WadRayMath from "./WadRayMath";
import { IMaths } from "./maths.interface";

export class AaveMath implements IMaths {
  INDEX_ONE(): BigInt {
    return WadRayMath.RAY;
  }

  indexMul(x: BigInt, y: BigInt): BigInt {
    return WadRayMath.rayMul(x, y);
  }

  indexDiv(x: BigInt, y: BigInt): BigInt {
    return WadRayMath.rayDiv(x, y);
  }
}
