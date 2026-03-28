import { BigInt, Bytes, ethereum, Address } from "@graphprotocol/graph-ts";
import {
  Created,
  Cancelled,
  TakeUp,
  Ended,
  Liquidated,
  Interrupted,
  ToppedUp,
  FeeCollected,
  ProtocolFeeUpdated,
  FeeRecipientUpdated,
  YieldAdapterUpdated,
  YieldSurplus,
  LoanFactory,
} from "../generated/LoanFactory/LoanFactory";
import {
  Protocol,
  Loan,
  LoanEvent,
  DailyLoanStat,
  UserStat,
  ProtocolConfigChange,
} from "../generated/schema";

// ── Constants ──

const PROTOCOL_ID = Bytes.fromHexString("0x01");
const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);
const SECONDS_PER_DAY = BigInt.fromI32(86400);

const STATUS_LABELS: string[] = ["s1", "s2", "s3", "s4"];

// ── Helpers ──

function getOrCreateProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (!protocol) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.loanCount = ZERO;
    protocol.activeLoans = ZERO;
    protocol.protocolFeeBps = BigInt.fromI32(500); // default
    protocol.feeRecipient = Bytes.empty();
    protocol.yieldAdapter = null;
    protocol.save();
  }
  return protocol;
}

function dayIdFromTimestamp(ts: BigInt): string {
  let dayTs = ts.div(SECONDS_PER_DAY).times(SECONDS_PER_DAY);
  let daysSinceEpoch = ts.div(SECONDS_PER_DAY);
  // Format as YYYY-MM-DD using epoch math
  // Simpler: use day number as ID
  return dayTs.toString();
}

function getOrCreateDailyStat(timestamp: BigInt): DailyLoanStat {
  let id = dayIdFromTimestamp(timestamp);
  let stat = DailyLoanStat.load(id);
  if (!stat) {
    stat = new DailyLoanStat(id);
    stat.date = id;
    stat.loansCreated = ZERO;
    stat.loansMatched = ZERO;
    stat.loansCancelled = ZERO;
    stat.loansLiquidated = ZERO;
    stat.loansEnded = ZERO;
    stat.loansInterrupted = ZERO;
    stat.totalFeesCollected = ZERO;
    stat.save();
  }
  return stat;
}

function getOrCreateUserStat(address: Bytes): UserStat {
  let stat = UserStat.load(address);
  if (!stat) {
    stat = new UserStat(address);
    stat.totalLoansCreated = ZERO;
    stat.totalLoansAsLender = ZERO;
    stat.totalLoansAsBorrower = ZERO;
    stat.activeLoanCount = ZERO;
    stat.save();
  }
  return stat;
}

function createLoanEvent(
  event: ethereum.Event,
  loan: Loan,
  eventType: string
): void {
  let id = event.transaction.hash.concatI32(event.logIndex.toI32());
  let loanEvent = new LoanEvent(id);
  loanEvent.loan = loan.id;
  loanEvent.type = eventType;
  loanEvent.timestamp = event.block.timestamp;
  loanEvent.blockNumber = event.block.number;
  loanEvent.txHash = event.transaction.hash;
  loanEvent.from = event.transaction.from;
  loanEvent.save();
}

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

/**
 * Decode loan ID from transaction input for functions that take a single uint256 `id` param:
 * cancelLoan(uint256), endLoan(uint256), liquidateLoan(uint256), interruptLoan(uint256)
 * Selector (4 bytes) + uint256 (32 bytes)
 */
function decodeSingleIdFromInput(input: Bytes): BigInt {
  // Skip 4-byte selector, read 32-byte uint256
  let idBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    idBytes[i] = input[i + 4];
  }
  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(idBytes.reverse()));
}

/**
 * For topUp(uint256 id, uint256 additionalCollateral): first param is the loan ID
 */
function decodeTopUpIdFromInput(input: Bytes): BigInt {
  return decodeSingleIdFromInput(input); // same position
}

/**
 * Load loan data from the contract via `loans(uint256)` view call
 */
function loadLoanFromContract(
  contractAddress: Address,
  loanId: BigInt
): void {
  let contract = LoanFactory.bind(contractAddress);
  let result = contract.try_loans(loanId);
  if (result.reverted) return;

  let loan = Loan.load(loanId.toString());
  if (!loan) return;

  let data = result.value;
  loan.collateralAmount = data.getCollateral();
  loan.initialCollateralRatio = data.getInitialCollateralRatio();
  loan.liquidationThreshold = data.getLiquidationThreshold();
  loan.lender = data.getLender();
  loan.borrower = data.getBorrower();
  loan.assetAddress = data.getAssetAddress();
  loan.collateralAddress = data.getCollateralAddress();
  loan.rateIndex = data.getRateIndex();
  loan.durationIndex = data.getDurationIndex();
  loan.startTime = data.getStartTime();

  let statusInt = data.getS();
  if (statusInt < STATUS_LABELS.length) {
    loan.status = STATUS_LABELS[statusInt];
  }

  loan.save();
}

// ── Event Handlers ──

export function handleCreated(event: Created): void {
  let protocol = getOrCreateProtocol();
  protocol.loanCount = protocol.loanCount.plus(ONE);
  protocol.activeLoans = protocol.activeLoans.plus(ONE);
  protocol.save();

  let loanId = event.params.id;
  let loan = new Loan(loanId.toString());
  loan.loanId = loanId;
  loan.creator = event.params.creator;
  loan.assetAmount = event.params.amount;
  loan.rateBps = event.params.rate;
  loan.durationDays = event.params.duration;
  loan.createdAt = event.block.timestamp;
  loan.createdAtBlock = event.block.number;
  loan.txHash = event.transaction.hash;

  let statusInt = event.params.s;
  loan.status = statusInt < STATUS_LABELS.length
    ? STATUS_LABELS[statusInt]
    : statusInt.toString();

  // Set creator as lender or borrower based on status
  if (loan.status == "s1") {
    loan.lender = event.params.creator;
  } else if (loan.status == "s2") {
    loan.borrower = event.params.creator;
  }

  loan.save();

  // Load full data from contract
  loadLoanFromContract(event.address, loanId);

  // Track event
  createLoanEvent(event, loan, "Created");

  // Daily stats
  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.loansCreated = daily.loansCreated.plus(ONE);
  daily.save();

  // User stats
  let userStat = getOrCreateUserStat(event.params.creator);
  userStat.totalLoansCreated = userStat.totalLoansCreated.plus(ONE);
  userStat.activeLoanCount = userStat.activeLoanCount.plus(ONE);
  userStat.save();
}

export function handleCancelled(event: Cancelled): void {
  // Cancelled is emitted from cancelLoan(id) and also from takeUpLoan
  // For cancelLoan: input is cancelLoan(uint256) — selector 0x... + id
  // For takeUpLoan: input is takeUpLoan(uint256, uint256) — different selector
  // We distinguish by checking the function selector

  let input = event.transaction.input;
  // cancelLoan selector: first 4 bytes
  // We need to find which loan was cancelled. Since Cancelled doesn't include the ID,
  // and it can be emitted multiple times in takeUpLoan, we'll use the log index
  // to try to correlate with other events in the same tx.

  // For the cancelLoan case (single call), decode the ID
  let cancelLoanSelector = Bytes.fromHexString("0xbdbfa3de"); // cancelLoan(uint256)

  let selectorBytes = Bytes.fromUint8Array(input.subarray(0, 4));

  if (selectorBytes.equals(cancelLoanSelector)) {
    let loanId = decodeSingleIdFromInput(input);
    let loan = Loan.load(loanId.toString());
    if (loan) {
      loan.status = "s4";
      loan.terminationReason = "cancelled";
      loan.endedAt = event.block.timestamp;
      loan.save();

      createLoanEvent(event, loan, "Cancelled");

      let protocol = getOrCreateProtocol();
      protocol.activeLoans = protocol.activeLoans.minus(ONE);
      protocol.save();

      let daily = getOrCreateDailyStat(event.block.timestamp);
      daily.loansCancelled = daily.loansCancelled.plus(ONE);
      daily.save();

      let userStat = getOrCreateUserStat(event.params.canceller);
      if (userStat.activeLoanCount.gt(ZERO)) {
        userStat.activeLoanCount = userStat.activeLoanCount.minus(ONE);
      }
      userStat.save();
    }
  }
  // For takeUpLoan-emitted Cancelled events, the TakeUp handler handles status changes
}

export function handleTakeUp(event: TakeUp): void {
  // takeUpLoan(uint256 takeUpId, uint256 offerId)
  let input = event.transaction.input;
  // Decode both IDs: skip 4-byte selector, read two uint256s
  let takeUpId = decodeSingleIdFromInput(input);

  let offerIdBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    offerIdBytes[i] = input[i + 36]; // offset 4 + 32
  }
  let offerId = BigInt.fromUnsignedBytes(
    Bytes.fromUint8Array(offerIdBytes.reverse())
  );

  // The offer (offerId) becomes the active loan (s3)
  let offer = Loan.load(offerId.toString());
  if (offer) {
    offer.status = "s3";
    offer.lender = event.params.lender;
    offer.borrower = event.params.borrower;
    offer.startTime = event.block.timestamp;
    offer.save();

    // Reload full state from contract
    loadLoanFromContract(event.address, offerId);

    createLoanEvent(event, offer, "TakeUp");
  }

  // The taker's offer (takeUpId) is consumed (s4)
  let taker = Loan.load(takeUpId.toString());
  if (taker) {
    taker.status = "s4";
    taker.terminationReason = "matched";
    taker.endedAt = event.block.timestamp;
    taker.save();
  }

  // Protocol: one loan consumed (taker's offer cancelled), one matched
  // Net active change: -1 (taker offer removed, existing offer transitions to s3)
  let protocol = getOrCreateProtocol();
  protocol.activeLoans = protocol.activeLoans.minus(ONE);
  protocol.save();

  // Daily stats
  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.loansMatched = daily.loansMatched.plus(ONE);
  daily.save();

  // User stats
  let lenderStat = getOrCreateUserStat(event.params.lender);
  lenderStat.totalLoansAsLender = lenderStat.totalLoansAsLender.plus(ONE);
  lenderStat.save();

  let borrowerStat = getOrCreateUserStat(event.params.borrower);
  borrowerStat.totalLoansAsBorrower =
    borrowerStat.totalLoansAsBorrower.plus(ONE);
  borrowerStat.save();
}

export function handleEnded(event: Ended): void {
  let loanId = decodeSingleIdFromInput(event.transaction.input);
  let loan = Loan.load(loanId.toString());
  if (!loan) return;

  loan.status = "s4";
  loan.terminationReason = "ended";
  loan.endedAt = event.block.timestamp;
  loan.save();

  createLoanEvent(event, loan, "Ended");

  let protocol = getOrCreateProtocol();
  protocol.activeLoans = protocol.activeLoans.minus(ONE);
  protocol.save();

  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.loansEnded = daily.loansEnded.plus(ONE);
  daily.save();
}

export function handleLiquidated(event: Liquidated): void {
  let loanId = decodeSingleIdFromInput(event.transaction.input);
  let loan = Loan.load(loanId.toString());
  if (!loan) return;

  loan.status = "s4";
  loan.terminationReason = "liquidated";
  loan.endedAt = event.block.timestamp;
  loan.save();

  createLoanEvent(event, loan, "Liquidated");

  let protocol = getOrCreateProtocol();
  protocol.activeLoans = protocol.activeLoans.minus(ONE);
  protocol.save();

  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.loansLiquidated = daily.loansLiquidated.plus(ONE);
  daily.save();
}

export function handleInterrupted(event: Interrupted): void {
  let loanId = decodeSingleIdFromInput(event.transaction.input);
  let loan = Loan.load(loanId.toString());
  if (!loan) return;

  loan.status = "s4";
  loan.terminationReason = "interrupted";
  loan.endedAt = event.block.timestamp;
  loan.save();

  createLoanEvent(event, loan, "Interrupted");

  let protocol = getOrCreateProtocol();
  protocol.activeLoans = protocol.activeLoans.minus(ONE);
  protocol.save();

  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.loansInterrupted = daily.loansInterrupted.plus(ONE);
  daily.save();
}

export function handleToppedUp(event: ToppedUp): void {
  let loanId = decodeTopUpIdFromInput(event.transaction.input);
  let loan = Loan.load(loanId.toString());
  if (!loan) return;

  // Reload to get updated collateral
  loadLoanFromContract(event.address, loanId);

  createLoanEvent(event, loan, "ToppedUp");
}

export function handleFeeCollected(event: FeeCollected): void {
  // FeeCollected fires during createLoan, so the loan was just created
  // The most recent loan is loanCounter - 1, but we can get it from the
  // Created event in the same tx. Use protocol.loanCount as proxy.
  let protocol = getOrCreateProtocol();
  let loanId = protocol.loanCount; // current loan count = ID of last created loan

  let loan = Loan.load(loanId.toString());
  if (loan) {
    loan.feeCollectedAmount = event.params.amount;
    loan.feeCollectedToken = event.params.token;
    loan.save();
  }

  let daily = getOrCreateDailyStat(event.block.timestamp);
  daily.totalFeesCollected = daily.totalFeesCollected.plus(event.params.amount);
  daily.save();
}

export function handleYieldSurplus(event: YieldSurplus): void {
  let loan = Loan.load(event.params.loanId.toString());
  if (!loan) return;

  loan.yieldSurplusAmount = event.params.amount;
  loan.yieldSurplusToken = event.params.token;
  loan.yieldSurplusRecipient = event.params.recipient;
  loan.save();
}

// ── Config change handlers ──

export function handleProtocolFeeUpdated(event: ProtocolFeeUpdated): void {
  let protocol = getOrCreateProtocol();
  protocol.protocolFeeBps = event.params.newFeeBps;
  protocol.save();

  let change = new ProtocolConfigChange(eventId(event));
  change.type = "ProtocolFeeUpdated";
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.txHash = event.transaction.hash;
  change.oldValue = event.params.oldFeeBps;
  change.newValue = event.params.newFeeBps;
  change.save();
}

export function handleFeeRecipientUpdated(
  event: FeeRecipientUpdated
): void {
  let protocol = getOrCreateProtocol();
  protocol.feeRecipient = event.params.newRecipient;
  protocol.save();

  let change = new ProtocolConfigChange(eventId(event));
  change.type = "FeeRecipientUpdated";
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.txHash = event.transaction.hash;
  change.oldAddress = event.params.oldRecipient;
  change.newAddress = event.params.newRecipient;
  change.save();
}

export function handleYieldAdapterUpdated(
  event: YieldAdapterUpdated
): void {
  let protocol = getOrCreateProtocol();
  protocol.yieldAdapter = event.params.newAdapter;
  protocol.save();

  let change = new ProtocolConfigChange(eventId(event));
  change.type = "YieldAdapterUpdated";
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.txHash = event.transaction.hash;
  change.oldAddress = event.params.oldAdapter;
  change.newAddress = event.params.newAdapter;
  change.save();
}
