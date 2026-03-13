# Module 2: Undercollateralized Credit Markets (EVM)

## Architecture Overview

Module 2 implements a permissioned, undercollateralized lending protocol on EVM. The Orchestrator contract acts as the central governance and factory, deploying per-borrower CreditMarket instances. Each market issues LoanPositionTokens (ERC-20) to lenders as receipt tokens. Supporting contracts handle sanctions screening (SanctionsSentinel), price feed integration (PriceFeedAdapter), and cross-chain state synchronization with Canton (TICSBridge).

### Contract Relationships

```
                         +-----------------+
                         |   Orchestrator  |
                         |  (Governance +  |
                         |   Factory)      |
                         +--------+--------+
                                  |
            +---------------------+---------------------+
            |                     |                     |
            v                     v                     v
    +---------------+    +----------------+    +-----------------+
    | CreditMarket  |    | SanctionsSent. |    | PriceFeedAdapt. |
    | (per borrower |    | (Chainalysis   |    | (Chainlink      |
    |  per asset)   |    |  wrapper)      |    |  price feeds)   |
    +-------+-------+    +----------------+    +-----------------+
            |
            v
    +------------------+         +------------------+
    | LoanPositionToken|         |    TICSBridge    |
    | (ERC-20 receipt  |         | (EVM <-> Canton  |
    |  per market)     |         |  state sync)     |
    +------------------+         +------------------+
```

### Contracts

| Contract | LOC | Description |
|----------|-----|-------------|
| `Orchestrator.sol` | ~320 | Central governance: borrower authorization, market factory, lender whitelist, credit limit enforcement |
| `CreditMarket.sol` | ~550 | Per-borrower credit facility: deposit, borrow, repay, withdrawal batching, interest accrual, margin call, liquidation |
| `LoanPositionToken.sol` | ~120 | Non-rebasing ERC-20 receipt token; scaled balance grows in value as interest accrues |
| `TICSBridge.sol` | ~360 | EVM-Canton state synchronization via ECDSA-attested state hashes and collateral lifecycle management |
| `SanctionsSentinel.sol` | ~70 | Wraps Chainalysis sanctions oracle with owner-managed overrides; safe testnet default |
| `PriceFeedAdapter.sol` | ~80 | Wraps Chainlink AggregatorV3Interface with staleness validation |

### Libraries

| Library | Purpose |
|---------|---------|
| `CreditTypesLib.sol` | Shared enums (CreditTier, MarketStatus, WithdrawalStatus) and structs (MarketParameters, CreditMarketState, BorrowerAuth) |
| `ScaleFactorLib.sol` | RAY-based (1e27) interest accrual math, scale/normalize conversions, liquidity calculations |
| `CreditErrors.sol` | Custom error definitions |
| `CreditEvents.sol` | Event definitions |

## Key Flows

### 1. Market Creation

```
Owner -> Orchestrator.authorizeBorrower(addr, tier)
Owner -> Orchestrator.createMarket(borrower, asset, params)
         |-> deploys CreditMarket(borrower, asset, orchestrator, params)
         |-> deploys LoanPositionToken(name, "LPT", market, orchestrator)
         |-> CreditMarket.setPositionToken(lpt)
         |-> registers market in _markets mapping
Owner -> Orchestrator.registerLender(market, lender)
```

### 2. Deposit

```
Lender -> CreditMarket.deposit(amount, onBehalfOf)
          |-> verifies lender in Orchestrator.isKnownLender()
          |-> accrues interest
          |-> checks max supply cap
          |-> calculates scaledAmount = scaleAmount(amount, scaleFactor)
          |-> transfers ERC-20 asset from lender
          |-> mints LoanPositionToken to onBehalfOf
```

### 3. Borrow

```
Borrower -> CreditMarket.borrow(amount)
            |-> accrues interest
            |-> verifies available liquidity > liquidityRequired
            |-> Orchestrator.checkAndRecordBorrow(market, amount) [cross-market credit limit]
            |-> updates totalBorrowed
            |-> transfers asset to borrower
```

### 4. Repay

```
Anyone -> CreditMarket.repay(amount)
          |-> accrues interest
          |-> reduces totalBorrowed
          |-> Orchestrator.recordRepayment(market, amount)
          |-> transfers asset from msg.sender
          |-> updates delinquency status
```

### 5. Withdrawal

```
Lender -> CreditMarket.requestWithdrawal(scaledAmount)
          |-> adds to current withdrawal batch (or creates new batch)
          |-> burns LoanPositionToken from lender
          |-> increases scaledPendingWithdrawals

Anyone -> CreditMarket.processWithdrawalBatch()  [after batch expiry]
          |-> allocates available liquidity to batch (FIFO)
          |-> updates normalizedUnclaimedWithdrawals

Lender -> CreditMarket.claimWithdrawal(batchExpiry)
          |-> calculates proportional share
          |-> transfers asset to lender
```

### 6. Margin Call and Liquidation

```
Operator -> CreditMarket.marginCall()
            |-> requires: isDelinquent AND past grace period
            |-> sets 72-hour cure deadline

Borrower -> CreditMarket.cure()
            |-> requires: delinquency resolved
            |-> clears margin call state

Operator -> CreditMarket.liquidate()  [after deadline]
            |-> sets isLiquidating = true
            |-> prevents new borrows
```

## Parameter Reference: MarketParameters

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `annualInterestBips` | uint16 | Annual interest rate in basis points | 500 = 5% APR |
| `delinquencyFeeBips` | uint16 | Penalty fee rate applied after grace period | 1000 = 10% |
| `withdrawalBatchDuration` | uint32 | Seconds per withdrawal batch window | 604800 = 7 days |
| `reserveRatioBips` | uint16 | Required reserve as % of outstanding (max 5000) | 2000 = 20% |
| `delinquencyGracePeriod` | uint32 | Seconds before penalty fees begin | 604800 = 7 days |
| `protocolFeeBips` | uint16 | Protocol's cut of base interest | 100 = 1% |
| `maxDelinquencyPeriod` | uint32 | Cap on delinquency fee accrual (seconds) | 2592000 = 30 days |
| `maxTotalSupply` | uint128 | Maximum deposit cap | 1000000e18 |
| `maturityDate` | uint32 | Unix timestamp; 0 = perpetual (no maturity) | 0 |
| `gmslaRefHash` | bytes32 | keccak256 of GMSLA reference; bytes32(0) = none | bytes32(0) |
| `collateralRatioBps` | uint16 | Required collateral ratio; 0 = unsecured, max 15000 | 0 |

## Credit Tiers

| Tier | Enum | Max Credit Limit |
|------|------|-----------------|
| TIER_1 | 0 | $100,000 |
| TIER_2 | 1 | $500,000 |
| TIER_3 | 2 | $2,000,000 |
| TIER_4 | 3 | $10,000,000 |

## State Machine

```
                    +---------+
                    |  Active |
                    +----+----+
                         |
              assets < liquidityRequired
                         |
                         v
                  +-------------+
                  | Delinquent  |
                  +------+------+
                         |
              past delinquencyGracePeriod
                         |
                         v
                  +------------+
              +-->| MarginCall |<--+ (cure: resolve delinquency)
              |   +------+-----+  |
              |          |        |
              |    72h deadline   |
              |    expires        |
              |          |        |
              |          v        |
              |   +--------------+
              |   | Liquidating  |
              |   +--------------+
              |
              v
          +--------+
          | Closed |  (borrower calls closeMarket when no pending withdrawals)
          +--------+
```

## Testing

### Run All Tests

```bash
npx hardhat test
```

### Run Module 2 Tests Only

```bash
npx hardhat test --grep "Module2\|CreditMarket\|Orchestrator\|LoanPositionToken\|TICSBridge\|SanctionsSentinel\|PriceFeedAdapter"
```

### Test Categories

- **Unit tests**: Individual contract function behavior
- **Integration tests**: Multi-contract flows (Orchestrator -> CreditMarket -> LPT)
- **Parity tests**: EVM vs DAML test vector comparison (`npx hardhat run scripts/parity-check.ts`)
- **Edge cases**: Zero amounts, overflow, reentrancy, unauthorized access

### Static Analysis

```bash
# Slither (if installed)
slither contracts/module2/
```

## Deployment

### Sepolia Testnet

```bash
npx hardhat run scripts/deploy-module2-sepolia.ts --network sepolia
```

Required environment variables: `PRIVATE_KEY`, `SEPOLIA_URL`, `ASSET_TOKEN`, `BORROWER_ADDRESS`.

See `scripts/deploy-module2-sepolia.ts` for full configuration options.

### ABI Export

```bash
npx hardhat run scripts/export-abis.ts
```

Exports to `exports/module2/`. See `exports/module2/index.ts` for TypeScript bindings.

### Contract Verification

```bash
npx hardhat run scripts/verify-module2.ts --network sepolia
```

## DAML Parity

Each EVM contract maps to a DAML template in `finkfi-canton/daml-contracts/src/Module2/`:

| EVM Contract | DAML Template | Notes |
|-------------|---------------|-------|
| Orchestrator | Orchestrator + BorrowerAuthorization | DAML splits governance from borrower auth |
| CreditMarket | Market | 1:1 choice mapping (11 choices in DAML) |
| LoanPositionToken | LenderPosition | Scaled balance model identical |
| TICSBridge | Audit (bridge templates) | Canton uses native Ledger API; bridge templates for attestations |
| SanctionsSentinel | (off-ledger) | Canton handles KYC/sanctions at party level |
| PriceFeedAdapter | (off-ledger) | Canton uses oracle feeds via JSON API |

---

**Status**: Sprint 5
**Last Updated**: March 2026
