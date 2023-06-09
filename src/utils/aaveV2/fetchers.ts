import { Address, BigDecimal, BigInt, log } from "@graphprotocol/graph-ts";

import { ChainlinkPriceFeed } from "../../../generated/morpho-v1/MorphoAaveV2/ChainlinkPriceFeed";
import { LendingPoolAddressesProvider } from "../../../generated/morpho-v1/MorphoAaveV2/LendingPoolAddressesProvider";
import { MorphoAaveV2 } from "../../../generated/morpho-v1/MorphoAaveV2/MorphoAaveV2";
import { PriceOracle } from "../../../generated/morpho-v1/MorphoAaveV2/PriceOracle";
import { LendingProtocol, Market } from "../../../generated/morpho-v1/schema";
import { pow10Decimal } from "../../bn";
import { ETH_USD_PRICE_FEED_ADDRESS, MORPHO_AAVE_V2_ADDRESS, readValue } from "../../constants";

export function fetchAssetPrice(market: Market): BigDecimal {
  const inputTokenAddress = Address.fromString(market.inputToken.toHexString());

  const morphoProtocol = LendingProtocol.load(MORPHO_AAVE_V2_ADDRESS);
  if (!morphoProtocol) return BigDecimal.zero(); // Morpho not initialized yet
  const morpho = MorphoAaveV2.bind(MORPHO_AAVE_V2_ADDRESS);
  const addressesProvider = LendingPoolAddressesProvider.bind(morpho.addressesProvider());

  const oracle = PriceOracle.bind(addressesProvider.getPriceOracle());

  let oracleResult = readValue<BigInt>(oracle.try_getAssetPrice(inputTokenAddress), BigInt.zero());

  // if the result is zero or less, try the fallback oracle
  if (!oracleResult.gt(BigInt.zero())) {
    const tryFallback = oracle.try_getFallbackOracle();
    if (tryFallback) {
      const fallbackOracle = PriceOracle.bind(tryFallback.value);
      oracleResult = readValue<BigInt>(
        fallbackOracle.try_getAssetPrice(inputTokenAddress),
        BigInt.zero()
      );
    }
  }

  // Mainnet Oracles return the price in eth, must convert to USD through the following method
  const ethPriceFeed = ChainlinkPriceFeed.bind(ETH_USD_PRICE_FEED_ADDRESS);
  const priceEthInUsd = ethPriceFeed.latestAnswer().toBigDecimal().div(pow10Decimal(8)); // price is in 8 decimals (10^8)

  if (priceEthInUsd.equals(BigDecimal.zero())) {
    return BigDecimal.zero();
  } else {
    return oracleResult.toBigDecimal().times(priceEthInUsd).div(pow10Decimal(18));
  }
}
