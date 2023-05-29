import { Address, BigDecimal, BigInt, ethereum, log } from "@graphprotocol/graph-ts";

import {
  _ActiveAccount,
  _PositionCounter,
  Account,
  Borrow,
  Deposit,
  Liquidate,
  Position,
  Repay,
  Withdraw,
} from "../../generated/morpho-v1/schema";
import { pow10, pow10Decimal } from "../bn";
import {
  BIGDECIMAL_HUNDRED,
  EventType,
  InterestRateSide,
  InterestRateType,
  MORPHO_AAVE_V3_ADDRESS,
  PositionSide,
} from "../constants";
import {
  addPosition,
  createAccount,
  createInterestRate,
  getEventId,
  snapshotUsage,
  subtractPosition,
  updateFinancials,
  updateMarketSnapshots,
  updateP2PRates,
  updateProtocolPosition,
  updateSnapshots,
} from "../helpers";
import { getMarket, getOrInitLendingProtocol, getOrInitToken } from "../utils/initializers";
import { IMaths } from "../utils/maths/maths.interface";

import { ReserveUpdateParams } from "./morpho-aave/lending-pool";

export function _handleSupplied(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  amount: BigInt,
  balanceOnPool: BigInt,
  balanceInP2P: BigInt,
  isCollateral: boolean
): void {
  const market = getMarket(marketAddress);

  const inputToken = getOrInitToken(market.inputToken);
  const protocol = getOrInitLendingProtocol(event.address);

  const deposit = new Deposit(getEventId(event.transaction.hash, event.logIndex));

  // create account
  let account = Account.load(accountID);
  if (!account) {
    account = createAccount(accountID);
    account.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  account.depositCount += 1;
  account.save();

  // update position
  const position = addPosition(
    protocol,
    market,
    account,
    PositionSide.LENDER,
    isCollateral ? EventType.DEPOSIT_COLLATERAL : EventType.DEPOSIT,
    event
  );

  if (isCollateral) {
    market._scaledPoolCollateral = market
      ._scaledPoolCollateral!.minus(position.balanceOnPool)
      .plus(balanceOnPool);
  } else {
    market._scaledSupplyOnPool = market._scaledSupplyOnPool
      .minus(position.balanceOnPool)
      .plus(balanceOnPool);
    market._scaledSupplyInP2P = market._scaledSupplyInP2P
      .minus(position.balanceInP2P)
      .plus(balanceInP2P);

    const virtualP2P = balanceInP2P.times(market._p2pSupplyIndex).div(market._lastPoolSupplyIndex);

    market._virtualScaledSupply = market._virtualScaledSupply
      .minus(position._virtualP2P)
      .plus(virtualP2P);

    position._virtualP2P = virtualP2P;
    position.balanceInP2P = balanceInP2P;
  }

  position.balanceOnPool = balanceOnPool;

  const totalSupplyOnPool = balanceOnPool
    .times(market._lastPoolSupplyIndex)
    .div(pow10(market._indexesOffset));
  const totalSupplyInP2P = balanceInP2P
    .times(market._p2pSupplyIndex)
    .div(pow10(market._indexesOffset));

  position.balance = totalSupplyOnPool.plus(totalSupplyInP2P);

  position.save();

  deposit.position = position.id;
  deposit.nonce = event.transaction.nonce;
  deposit.account = account.id;
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;
  deposit.market = market.id;
  deposit.hash = event.transaction.hash;
  deposit.logIndex = event.logIndex.toI32();
  deposit.asset = inputToken.id;
  deposit.amount = amount;
  deposit.amountUSD = amount
    .toBigDecimal()
    .div(pow10Decimal(inputToken.decimals))
    .times(market.inputTokenPriceUSD);
  deposit.isCollateral = isCollateral;
  deposit.gasPrice = event.transaction.gasPrice;
  deposit.gasLimit = event.transaction.gasLimit;
  deposit.save();

  // update metrics
  protocol.cumulativeDepositUSD = protocol.cumulativeDepositUSD.plus(deposit.amountUSD);
  protocol.depositCount += 1;
  protocol.save();
  market.cumulativeDepositUSD = market.cumulativeDepositUSD.plus(deposit.amountUSD);
  market.depositCount += 1;
  market.save();

  // update usage metrics
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    accountID.toHexString(),
    EventType.DEPOSIT,
    true
  );

  // udpate market daily / hourly snapshots / financialSnapshots
  updateSnapshots(
    protocol,
    market,
    deposit.amountUSD,
    deposit.amount,
    EventType.DEPOSIT,
    event.block.timestamp,
    event.block.number
  );
  updateProtocolPosition(protocol, market);
}

export function _handleWithdrawn(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  amount: BigInt,
  balanceOnPool: BigInt,
  balanceInP2P: BigInt,
  isCollateral: boolean
): void {
  const market = getMarket(marketAddress);

  const inputToken = getOrInitToken(market.inputToken);
  const protocol = getOrInitLendingProtocol(event.address);

  // create withdraw entity
  const withdraw = new Withdraw(getEventId(event.transaction.hash, event.logIndex));

  // get account
  let account = Account.load(accountID);
  if (!account) {
    account = createAccount(accountID);
    account.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  account.withdrawCount += 1;
  account.save();

  const totalSupplyOnPool = balanceOnPool
    .times(market._lastPoolSupplyIndex)
    .div(pow10(market._indexesOffset));
  const totalSupplyInP2P = balanceInP2P
    .times(market._p2pSupplyIndex)
    .div(pow10(market._indexesOffset));
  const balance = totalSupplyOnPool.plus(totalSupplyInP2P);

  const position = subtractPosition(
    protocol,
    market,
    account,
    balance,
    PositionSide.LENDER,
    isCollateral ? EventType.WITHDRAW_COLLATERAL : EventType.WITHDRAW,
    event
  );

  if (position === null) {
    log.critical("[handleWithdraw] Position not found for account: {} in transaction: {}", [
      accountID.toHexString(),
      event.transaction.hash.toHexString(),
    ]);
    return;
  }

  if (isCollateral) {
    market._scaledPoolCollateral = market
      ._scaledPoolCollateral!.minus(position.balanceOnPool)
      .plus(balanceOnPool);
  } else {
    market._scaledSupplyOnPool = market._scaledSupplyOnPool
      .minus(position.balanceOnPool)
      .plus(balanceOnPool);
    market._scaledSupplyInP2P = market._scaledSupplyInP2P
      .minus(position.balanceInP2P)
      .plus(balanceInP2P);

    // We count the virtual only for non collateral positions that can be matched p2p
    const virtualP2P = balanceInP2P.times(market._p2pSupplyIndex).div(market._lastPoolSupplyIndex);

    market._virtualScaledSupply = market._virtualScaledSupply
      .minus(position._virtualP2P)
      .plus(virtualP2P);

    position._virtualP2P = virtualP2P;

    position.balanceInP2P = balanceInP2P;
  }

  position.balanceOnPool = balanceOnPool;
  position.save();

  withdraw.position = position.id;
  withdraw.blockNumber = event.block.number;
  withdraw.timestamp = event.block.timestamp;
  withdraw.account = account.id;
  withdraw.market = market.id;
  withdraw.hash = event.transaction.hash;
  withdraw.nonce = event.transaction.nonce;
  withdraw.logIndex = event.logIndex.toI32();
  withdraw.asset = inputToken.id;
  withdraw.amount = amount;
  withdraw.amountUSD = amount
    .toBigDecimal()
    .div(pow10Decimal(inputToken.decimals))
    .times(market.inputTokenPriceUSD);
  withdraw.isCollateral = isCollateral;
  withdraw.gasPrice = event.transaction.gasPrice;
  withdraw.gasLimit = event.transaction.gasLimit;
  withdraw.save();

  protocol.withdrawCount += 1;
  protocol.save();
  market.withdrawCount += 1;
  market.save();

  // update usage metrics
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    withdraw.account.toHexString(),
    EventType.WITHDRAW,
    true
  );

  // udpate market daily / hourly snapshots / financialSnapshots
  updateSnapshots(
    protocol,
    market,
    withdraw.amountUSD,
    withdraw.amount,
    EventType.WITHDRAW,
    event.block.timestamp,
    event.block.number
  );
  updateProtocolPosition(protocol, market);
}

export function _handleLiquidated(
  event: ethereum.Event,
  collateralAddress: Address,
  debtAddress: Address,
  liquidator: Address,
  liquidated: Address,
  amountSeized: BigInt,
  amountRepaid: BigInt
): void {
  const collateralMarket = getMarket(collateralAddress);
  const debtMarket = getMarket(debtAddress);
  const inputToken = getOrInitToken(collateralMarket.inputToken);
  const protocol = getOrInitLendingProtocol(event.address);

  // create liquidate entity
  const liquidate = new Liquidate(getEventId(event.transaction.hash, event.logIndex));

  // update liquidators account
  let liquidatorAccount = Account.load(liquidator);
  if (!liquidatorAccount) {
    liquidatorAccount = createAccount(liquidator);
    liquidatorAccount.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  liquidatorAccount.liquidateCount += 1;
  liquidatorAccount.save();
  const liquidatorActorID = "liquidator".concat("-").concat(liquidatorAccount.id.toHexString());
  let liquidatorActor = _ActiveAccount.load(liquidatorActorID);
  if (!liquidatorActor) {
    liquidatorActor = new _ActiveAccount(liquidatorActorID);
    liquidatorActor.save();

    protocol.cumulativeUniqueLiquidators += 1;
    protocol.save();
  }

  // get borrower account
  let account = Account.load(liquidated);
  if (!account) {
    account = createAccount(liquidated);
    account.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  account.liquidationCount += 1;
  account.save();
  const liquidateeActorID = "liquidatee".concat("-").concat(account.id.toHexString());
  let liquidateeActor = _ActiveAccount.load(liquidateeActorID);
  if (!liquidateeActor) {
    liquidateeActor = new _ActiveAccount(liquidateeActorID);
    liquidateeActor.save();

    protocol.cumulativeUniqueLiquidatees += 1;
    protocol.save();
  }

  // Update positions
  const positions: string[] = [];
  const counterIDDebt = account.id
    .toHexString()
    .concat("-")
    .concat(debtMarket.id.toHexString())
    .concat("-")
    .concat(PositionSide.BORROWER);

  const positionCounterDebt = _PositionCounter.load(counterIDDebt);
  if (!positionCounterDebt && amountRepaid.gt(BigInt.zero())) {
    log.warning("[Liquidation] no position counter found for {}", [counterIDDebt]);
    log.critical("[Liquidation] no position counter found for {}", [counterIDDebt]);
    return;
  }
  if (positionCounterDebt) {
    const positionDebtID = positionCounterDebt.id
      .concat("-")
      .concat(positionCounterDebt.nextCount.toString());
    let positionDebt = Position.load(positionDebtID);
    if (!positionDebt) {
      // That means that the liquidation has closed the position, so let's retrieve the last one
      if (positionCounterDebt.nextCount === 0) {
        log.warning("[Liquidation] counter is zero for position {}", [positionDebtID]);
        log.critical("[Liquidation] counter is zero for position {}", [positionDebtID]);
        return;
      }
      const positionID = positionCounterDebt.id
        .concat("-")
        .concat((positionCounterDebt.nextCount - 1).toString());
      positionDebt = Position.load(positionID);
      if (!positionDebt) {
        log.warning("[Liquidation] no position found for {}", [positionID]);
        log.critical("[Liquidation] no position found for {}", [positionID]);
        return;
      }
    }

    positionDebt.liquidationCount += 1;
    positionDebt.save();
    positions.push(positionDebt.id);
  }

  let counterIDCollateral = account.id
    .toHexString()
    .concat("-")
    .concat(collateralMarket.id.toHexString())
    .concat("-")
    .concat(PositionSide.LENDER);
  if (event.address.equals(MORPHO_AAVE_V3_ADDRESS)) counterIDCollateral += "-collateral"; // liquidate collateral position on ma3

  const counterPositionCollateral = _PositionCounter.load(counterIDCollateral);
  if (!counterPositionCollateral && amountSeized.gt(BigInt.zero())) {
    log.warning("[Liquidation] no position counter found for {}", [counterIDCollateral]);
    log.critical("[Liquidation] no position counter found for {}", [counterIDCollateral]);
    return;
  }
  if (counterPositionCollateral) {
    const positionCollateralID = counterPositionCollateral.id
      .concat("-")
      .concat(counterPositionCollateral.nextCount.toString());
    let positionCollateral = Position.load(positionCollateralID);
    if (!positionCollateral) {
      // That means that the liquidation has closed the position, so let's retrieve the last one
      if (counterPositionCollateral.nextCount === 0) {
        log.warning("[Liquidation] counter is zero for position {}", [positionCollateralID]);
        log.critical("[Liquidation] counter is zero for position {}", [positionCollateralID]);
        return;
      }
      const positionID = counterPositionCollateral.id
        .concat("-")
        .concat((counterPositionCollateral.nextCount - 1).toString());
      positionCollateral = Position.load(positionID);
      if (!positionCollateral) {
        log.warning("[Liquidation] no position found for {}", [positionID]);
        log.critical("[Liquidation] no position found for {}", [positionID]);
        return;
      }
    }

    positionCollateral.liquidationCount += 1;
    positionCollateral.save();
    positions.push(positionCollateral.id);
  }

  const repayTokenMarket = getMarket(debtAddress);
  const debtAsset = getOrInitToken(repayTokenMarket.inputToken);
  // repaid position was updated in the repay event earlier

  liquidate.blockNumber = event.block.number;
  liquidate.timestamp = event.block.timestamp;
  liquidate.positions = positions;
  liquidate.liquidator = liquidator;
  liquidate.liquidatee = liquidated;
  liquidate.market = collateralMarket.id;
  liquidate.hash = event.transaction.hash;
  liquidate.nonce = event.transaction.nonce;
  liquidate.logIndex = event.logIndex.toI32();
  liquidate.asset = repayTokenMarket.inputToken;
  liquidate.amount = amountSeized;
  liquidate.amountUSD = amountSeized
    .toBigDecimal()
    .div(pow10Decimal(inputToken.decimals))
    .times(collateralMarket.inputTokenPriceUSD);
  liquidate.profitUSD = liquidate.amountUSD.minus(
    amountRepaid
      .toBigDecimal()
      .div(pow10Decimal(debtAsset.decimals))
      .times(repayTokenMarket.inputTokenPriceUSD)
  );
  liquidate.save();

  protocol.cumulativeLiquidateUSD = protocol.cumulativeLiquidateUSD.plus(liquidate.amountUSD);
  protocol.liquidationCount += 1;
  protocol.save();
  collateralMarket.cumulativeLiquidateUSD = collateralMarket.cumulativeLiquidateUSD.plus(
    liquidate.amountUSD
  );
  collateralMarket.liquidationCount += 1;
  collateralMarket.save();

  // update usage metrics
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    liquidate.liquidatee.toHexString(),
    EventType.LIQUIDATEE,
    true // only count this liquidate as new tx
  );
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    liquidate.liquidator.toHexString(),
    EventType.LIQUIDATOR, // updates dailyActiveLiquidators
    false
  );

  // udpate market daily / hourly snapshots / financialSnapshots
  updateSnapshots(
    protocol,
    collateralMarket,
    liquidate.amountUSD,
    liquidate.amount,
    EventType.LIQUIDATOR,
    event.block.timestamp,
    event.block.number
  );
}

export function _handleBorrowed(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  amount: BigInt,
  onPool: BigInt,
  inP2P: BigInt
): void {
  const market = getMarket(marketAddress);
  const inputToken = getOrInitToken(market.inputToken);
  const protocol = getOrInitLendingProtocol(event.address);

  // create borrow entity
  const borrow = new Borrow(getEventId(event.transaction.hash, event.logIndex));

  // create account
  let account = Account.load(accountID);
  if (!account) {
    account = createAccount(accountID);
    account.save();
    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  if (account.borrowCount === 0) {
    protocol.cumulativeUniqueBorrowers += 1;
  }
  account.borrowCount += 1;
  account.save();

  // update position
  const position = addPosition(
    protocol,
    market,
    account,
    PositionSide.BORROWER,
    EventType.BORROW,
    event
  );

  const virtualP2P = inP2P.times(market._p2pBorrowIndex).div(market._lastPoolBorrowIndex);

  market._scaledBorrowOnPool = market._scaledBorrowOnPool
    .minus(position.balanceOnPool)
    .plus(onPool);

  market._scaledBorrowInP2P = market._scaledBorrowInP2P.minus(position.balanceInP2P).plus(inP2P);

  market._virtualScaledBorrow = market._virtualScaledBorrow
    .minus(position._virtualP2P)
    .plus(virtualP2P);

  position.balanceOnPool = onPool;
  position.balanceInP2P = inP2P;
  position._virtualP2P = virtualP2P;

  const borrowOnPool = onPool.times(market._lastPoolBorrowIndex).div(pow10(market._indexesOffset));
  const borrowInP2P = inP2P.times(market._p2pBorrowIndex).div(pow10(market._indexesOffset));
  position.balance = borrowOnPool.plus(borrowInP2P);
  position.save();

  borrow.position = position.id;
  borrow.blockNumber = event.block.number;
  borrow.timestamp = event.block.timestamp;
  borrow.account = account.id;
  borrow.nonce = event.transaction.nonce;
  borrow.market = market.id;
  borrow.hash = event.transaction.hash;
  borrow.logIndex = event.logIndex.toI32();
  borrow.asset = inputToken.id;
  borrow.amount = amount;
  borrow.amountUSD = amount
    .toBigDecimal()
    .div(pow10Decimal(inputToken.decimals))
    .times(market.inputTokenPriceUSD);
  borrow.gasPrice = event.transaction.gasPrice;
  borrow.gasLimit = event.transaction.gasLimit;
  borrow.save();

  // update metrics
  protocol.cumulativeBorrowUSD = protocol.cumulativeBorrowUSD.plus(borrow.amountUSD);
  protocol.borrowCount += 1;
  protocol.save();
  market.cumulativeBorrowUSD = market.cumulativeBorrowUSD.plus(borrow.amountUSD);
  market.borrowCount += 1;
  market.save();

  // update usage metrics
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    borrow.account.toHexString(),
    EventType.BORROW,
    true
  );

  // udpate market daily / hourly snapshots / financialSnapshots
  updateSnapshots(
    protocol,
    market,
    borrow.amountUSD,
    borrow.amount,
    EventType.BORROW,
    event.block.timestamp,
    event.block.number
  );
  updateProtocolPosition(protocol, market);
}

export function _handleP2PIndexesUpdated(
  event: ethereum.Event,
  marketAddress: Address,
  poolSupplyIndex: BigInt,
  p2pSupplyIndex: BigInt,
  poolBorrowIndex: BigInt,
  p2pBorrowIndex: BigInt
): void {
  const market = getMarket(marketAddress);

  const protocol = getOrInitLendingProtocol(event.address);
  const inputToken = getOrInitToken(market.inputToken);

  // The token price is updated in reserveUpdated event
  // calculate new revenue
  // New Interest = totalScaledSupply * (difference in liquidity index)
  let totalSupplyOnPool = market._scaledSupplyOnPool;
  if (market._scaledPoolCollateral)
    totalSupplyOnPool = totalSupplyOnPool.plus(market._scaledPoolCollateral!);

  const supplyDeltaIndexes = poolSupplyIndex
    .minus(market._lastPoolSupplyIndex)
    .toBigDecimal()
    .div(pow10Decimal(market._indexesOffset));

  const poolSupplyInterest = supplyDeltaIndexes
    .times(totalSupplyOnPool.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  const virtualSupplyInterest = supplyDeltaIndexes
    .times(market._virtualScaledSupply.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  market._lastPoolSupplyIndex = poolSupplyIndex;

  const p2pSupplyInterest = p2pSupplyIndex
    .minus(market._p2pSupplyIndex)
    .toBigDecimal()
    .div(pow10Decimal(market._indexesOffset))
    .times(market._scaledSupplyInP2P.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  market._p2pSupplyIndex = p2pSupplyIndex;

  const borrowDeltaIndexes = poolBorrowIndex
    .minus(market._lastPoolBorrowIndex)
    .toBigDecimal()
    .div(pow10Decimal(market._indexesOffset));

  const poolBorrowInterest = borrowDeltaIndexes
    .times(market._scaledBorrowOnPool.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  const virtualBorrowInterest = borrowDeltaIndexes
    .times(market._virtualScaledBorrow.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  market._lastPoolBorrowIndex = poolBorrowIndex;

  const p2pBorrowInterest = p2pBorrowIndex
    .minus(market._p2pBorrowIndex)
    .toBigDecimal()
    .div(pow10Decimal(market._indexesOffset))
    .times(market._scaledBorrowInP2P.toBigDecimal())
    .div(pow10Decimal(inputToken.decimals));

  market._p2pBorrowIndex = p2pBorrowIndex;

  const totalRevenueDelta = poolSupplyInterest.plus(p2pSupplyInterest);

  const totalRevenueDeltaUSD = totalRevenueDelta.times(market.inputTokenPriceUSD);

  const protocolSideRevenueDeltaUSD = BigDecimal.zero(); // no fees for now, TODO: use the reserve factor

  const supplySideRevenueDeltaUSD = totalRevenueDeltaUSD.minus(protocolSideRevenueDeltaUSD);

  // Morpho specific: update the interests generated/morpho-v1 on Morpho by both suppliers and borrowers, matched or not
  market.poolSupplyInterests = market.poolSupplyInterests.plus(poolSupplyInterest);
  market.poolSupplyInterestsUSD = market.poolSupplyInterestsUSD.plus(
    poolSupplyInterest.times(market.inputTokenPriceUSD)
  );

  market.p2pSupplyInterests = market.p2pSupplyInterests.plus(p2pSupplyInterest);
  market.p2pSupplyInterestsUSD = market.p2pSupplyInterestsUSD.plus(
    p2pSupplyInterest.times(market.inputTokenPriceUSD)
  );

  market.poolBorrowInterests = market.poolBorrowInterests.plus(poolBorrowInterest);
  market.poolBorrowInterestsUSD = market.poolBorrowInterestsUSD.plus(
    poolBorrowInterest.times(market.inputTokenPriceUSD)
  );

  market.p2pBorrowInterests = market.p2pBorrowInterests.plus(p2pBorrowInterest);
  market.p2pBorrowInterestsUSD = market.p2pBorrowInterestsUSD.plus(
    p2pBorrowInterest.times(market.inputTokenPriceUSD)
  );

  market.p2pSupplyInterestsImprovement = market.p2pSupplyInterestsImprovement.plus(
    p2pSupplyInterest.minus(virtualSupplyInterest)
  );

  market.p2pSupplyInterestsImprovementUSD = market.p2pSupplyInterestsImprovementUSD.plus(
    p2pSupplyInterest.minus(virtualSupplyInterest).times(market.inputTokenPriceUSD)
  );

  market.p2pBorrowInterestsImprovement = market.p2pBorrowInterestsImprovement.plus(
    virtualBorrowInterest.minus(p2pBorrowInterest)
  );

  market.p2pBorrowInterestsImprovementUSD = market.p2pBorrowInterestsImprovementUSD.plus(
    virtualBorrowInterest.minus(p2pBorrowInterest).times(market.inputTokenPriceUSD)
  );

  market.cumulativeTotalRevenueUSD = market.cumulativeTotalRevenueUSD.plus(totalRevenueDeltaUSD);
  market.cumulativeProtocolSideRevenueUSD = market.cumulativeProtocolSideRevenueUSD.plus(
    protocolSideRevenueDeltaUSD
  );
  market.cumulativeSupplySideRevenueUSD =
    market.cumulativeSupplySideRevenueUSD.plus(supplySideRevenueDeltaUSD);

  protocol.cumulativeTotalRevenueUSD =
    protocol.cumulativeTotalRevenueUSD.plus(totalRevenueDeltaUSD);
  protocol.cumulativeProtocolSideRevenueUSD = protocol.cumulativeProtocolSideRevenueUSD.plus(
    protocolSideRevenueDeltaUSD
  );
  protocol.cumulativeSupplySideRevenueUSD =
    protocol.cumulativeSupplySideRevenueUSD.plus(supplySideRevenueDeltaUSD);

  market.save();
  protocol.save();

  updateProtocolPosition(protocol, market);

  // update financial snapshot
  updateFinancials(
    event,
    protocol,
    totalRevenueDeltaUSD,
    protocolSideRevenueDeltaUSD,
    supplySideRevenueDeltaUSD
  );

  // update revenue in market snapshots
  updateMarketSnapshots(
    event.block.number,
    event.block.timestamp,
    market,
    totalRevenueDeltaUSD,
    supplySideRevenueDeltaUSD,
    protocolSideRevenueDeltaUSD
  );
}

export function _handleRepaid(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  amount: BigInt,
  balanceOnPool: BigInt,
  balanceInP2P: BigInt
): void {
  const market = getMarket(marketAddress);

  const inputToken = getOrInitToken(market.inputToken);
  const protocol = getOrInitLendingProtocol(event.address);

  // create repay entity
  const repay = new Repay(getEventId(event.transaction.hash, event.logIndex));

  // get account
  let account = Account.load(accountID);
  if (!account) {
    account = createAccount(accountID);
    account.save();

    protocol.cumulativeUniqueUsers += 1;
    protocol.save();
  }
  account.repayCount += 1;
  account.save();

  const borrowOnPool = balanceOnPool
    .times(market._lastPoolBorrowIndex)
    .div(pow10(market._indexesOffset));
  const borrowInP2P = balanceInP2P.times(market._p2pBorrowIndex).div(pow10(market._indexesOffset));
  const balance = borrowOnPool.plus(borrowInP2P);

  const position = subtractPosition(
    protocol,
    market,
    account,
    balance, // try getting balance of account in debt market
    PositionSide.BORROWER,
    EventType.REPAY,
    event
  );
  if (position === null) {
    log.warning("[handleRepay] Position not found for account: {} in transaction; {}", [
      accountID.toHexString(),
      event.transaction.hash.toHexString(),
    ]);
    return;
  }
  const virtualP2P = balanceInP2P.times(market._p2pBorrowIndex).div(market._lastPoolBorrowIndex);

  market._virtualScaledBorrow = market._virtualScaledBorrow
    .minus(position._virtualP2P)
    .plus(virtualP2P);
  market._scaledBorrowOnPool = market._scaledBorrowOnPool
    .minus(position.balanceOnPool)
    .plus(balanceOnPool);
  market._scaledBorrowInP2P = market._scaledBorrowInP2P
    .minus(position.balanceInP2P)
    .plus(balanceInP2P);

  position.balanceOnPool = balanceOnPool;
  position.balanceInP2P = balanceInP2P;
  position._virtualP2P = virtualP2P;

  position.save();

  repay.position = position.id;
  repay.blockNumber = event.block.number;
  repay.timestamp = event.block.timestamp;
  repay.account = account.id;
  repay.market = market.id;
  repay.hash = event.transaction.hash;
  repay.nonce = event.transaction.nonce;
  repay.logIndex = event.logIndex.toI32();
  repay.asset = inputToken.id;
  repay.amount = amount;
  repay.amountUSD = amount
    .toBigDecimal()
    .div(pow10Decimal(inputToken.decimals))
    .times(market.inputTokenPriceUSD);
  repay.gasPrice = event.transaction.gasPrice;
  repay.gasLimit = event.transaction.gasLimit;
  repay.save();

  protocol.repayCount += 1;
  protocol.save();
  market.repayCount += 1;

  market.save();

  // update usage metrics
  snapshotUsage(
    protocol,
    event.block.number,
    event.block.timestamp,
    repay.account.toHexString(),
    EventType.REPAY,
    true
  );

  // udpate market daily / hourly snapshots / financialSnapshots
  updateSnapshots(
    protocol,
    market,
    repay.amountUSD,
    repay.amount,
    EventType.REPAY,
    event.block.timestamp,
    event.block.number
  );
  updateProtocolPosition(protocol, market);
}

export function _handleReserveUpdate(params: ReserveUpdateParams, __MATHS__: IMaths): void {
  const market = getMarket(params.marketAddress);

  // Update the total supply and borrow frequently by using pool updates
  const totalDepositBalanceUSD = market.totalSupplyOnPool
    .plus(market.totalSupplyInP2P)
    .times(market.inputTokenPriceUSD);
  params.protocol.totalDepositBalanceUSD = params.protocol.totalDepositBalanceUSD
    .minus(market.totalDepositBalanceUSD)
    .plus(totalDepositBalanceUSD);
  market.totalDepositBalanceUSD = totalDepositBalanceUSD;

  const totalBorrowBalanceUSD = market.totalBorrowOnPool
    .plus(market.totalBorrowInP2P)
    .times(market.inputTokenPriceUSD);
  params.protocol.totalBorrowBalanceUSD = params.protocol.totalBorrowBalanceUSD
    .minus(market.totalBorrowBalanceUSD)
    .plus(totalBorrowBalanceUSD);
  market.totalBorrowBalanceUSD = totalBorrowBalanceUSD;
  params.protocol.totalValueLockedUSD = params.protocol.totalDepositBalanceUSD;
  market.totalValueLockedUSD = market.totalDepositBalanceUSD;
  params.protocol.save();
  // Update pool indexes
  market._reserveSupplyIndex = params.reserveSupplyIndex;
  market._reserveBorrowIndex = params.reserveBorrowIndex;
  market._poolSupplyRate = params.poolSupplyRate;
  market._poolBorrowRate = params.poolBorrowRate;
  market._lastReserveUpdate = params.event.block.timestamp;

  // update rates as APR as it is done for aave subgraphs
  const supplyRate = params.poolSupplyRate.toBigDecimal().div(pow10Decimal(market._indexesOffset));

  const borrowRate = params.poolBorrowRate.toBigDecimal().div(pow10Decimal(market._indexesOffset));
  const poolSupplyRate = createInterestRate(
    market.id,
    InterestRateSide.LENDER,
    InterestRateType.POOL,
    supplyRate.times(BIGDECIMAL_HUNDRED)
  );
  const poolBorrowRate = createInterestRate(
    market.id,
    InterestRateSide.BORROWER,
    InterestRateType.POOL,
    borrowRate.times(BIGDECIMAL_HUNDRED)
  );

  market.rates = [
    poolSupplyRate.id,
    poolSupplyRate.id, // p2p rates are updated right after
    poolBorrowRate.id, // p2p rates are updated right after
    poolBorrowRate.id,
  ];

  updateP2PRates(market, __MATHS__);

  updateProtocolPosition(params.protocol, market);

  market.save();
  return;
}

export function _handleSupplierPositionUpdated(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  onPool: BigInt,
  inP2P: BigInt
): void {
  const protocol = getOrInitLendingProtocol(event.address);
  const market = getMarket(marketAddress);
  const account = Account.load(accountID);
  if (!account) {
    log.critical("Account not found for accountID: {}", [accountID.toHexString()]);
    return;
  }
  const position = addPosition(
    protocol,
    market,
    account,
    PositionSide.LENDER,
    EventType.SUPPLIER_POSITION_UPDATE,
    event
  );
  const virtualP2P = inP2P.times(market._p2pSupplyIndex).div(market._lastPoolSupplyIndex);

  market._virtualScaledSupply = market._virtualScaledSupply
    .minus(position._virtualP2P)
    .plus(virtualP2P);

  market._scaledSupplyOnPool = market._scaledSupplyOnPool
    .minus(position.balanceOnPool)
    .plus(onPool);
  market._scaledSupplyInP2P = market._scaledSupplyInP2P.minus(position.balanceInP2P).plus(inP2P);

  position.balanceOnPool = onPool;
  position.balanceInP2P = inP2P;
  position._virtualP2P = virtualP2P;

  position.save();
  market.save();
}

export function _handleBorrowerPositionUpdated(
  event: ethereum.Event,
  marketAddress: Address,
  accountID: Address,
  onPool: BigInt,
  inP2P: BigInt
): void {
  const protocol = getOrInitLendingProtocol(event.address);
  const market = getMarket(marketAddress);
  const account = Account.load(accountID);
  if (!account) {
    log.critical("Account not found for accountID: {}", [accountID.toHexString()]);
    return;
  }
  const position = addPosition(
    protocol,
    market,
    account,
    PositionSide.BORROWER,
    EventType.BORROWER_POSITION_UPDATE,
    event
  );
  const virtualP2P = inP2P.times(market._p2pBorrowIndex).div(market._lastPoolBorrowIndex);

  market._virtualScaledBorrow = market._virtualScaledBorrow
    .minus(position._virtualP2P)
    .plus(virtualP2P);

  market._scaledBorrowOnPool = market._scaledBorrowOnPool
    .minus(position.balanceOnPool)
    .plus(onPool);
  market._scaledBorrowInP2P = market._scaledBorrowInP2P.minus(position.balanceInP2P).plus(inP2P);

  position.balanceOnPool = onPool;
  position.balanceInP2P = inP2P;
  position._virtualP2P = virtualP2P;

  position.save();
  market.save();
}
