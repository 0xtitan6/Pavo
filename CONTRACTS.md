# ParthenonFi Smart Contracts — Full Reference

A developer-focused guide to every contract in this repo: what it does, how it fits into the system, and every public function, event, and error.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Core Types & Structs](#core-types--structs)
3. [Module 1 — P2P Lending](#module-1--p2p-lending)
   - [LoanFactory](#loanfactory)
   - [LoanCalculator (Library)](#loancalculator-library)
   - [AssetRegistry](#assetregistry)
   - [PriceOracle](#priceoracle)
4. [Yield Adapters](#yield-adapters)
   - [IYieldAdapter (Interface)](#iyieldadapter-interface)
   - [OptimizerAdapter](#optimizeradapter) — Recommended
   - [ParthenonVaultAdapter](#parthenonvaultadapter)
   - [MorphoAdapter](#morphoadapter) — Deprecated
5. [Yield Infrastructure](#yield-infrastructure)
   - [ParthenonOptimizer](#parthenonoptimizer)
   - [ParthenonPool](#parthenonpool)
   - [FixedRateIrm](#fixedrateirm)
   - [PoolOracleAdapter](#pooloracleadapter)
6. [Module 2 — Credit Markets](#module-2--credit-markets)
   - [Orchestrator](#orchestrator)
   - [CreditMarket](#creditmarket)
   - [TICSBridge](#ticsbridge)
   - [LoanPositionToken](#loanpositiontoken)
   - [SanctionsSentinel](#sanctionssentinel)
   - [PriceFeedAdapter](#pricefeedadapter)

---

## System Architecture

ParthenonFi is a **two-module RWA lending protocol**.

```
┌──────────────────────────────────────────────────────────────────┐
│                    MODULE 1: P2P Lending                         │
│                                                                  │
│  LoanFactory ──→ IYieldAdapter ──→ OptimizerAdapter             │
│      │                                    │                      │
│  PriceOracle                    ParthenonOptimizer (ERC-4626)   │
│  AssetRegistry                       │                           │
│  LoanCalculator (lib)            ParthenonPool                   │
│                                  (isolated markets)              │
│                                       │                          │
│                                  FixedRateIrm                    │
│                                  PoolOracleAdapter               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                    MODULE 2: Credit Markets                      │
│                                                                  │
│  Orchestrator ──→ CreditMarket (per borrower/asset)             │
│       │                 │                                        │
│  SanctionsSentinel  LoanPositionToken (ERC-20 claims)           │
│  PriceFeedAdapter       │                                        │
│                     TICSBridge ←──→ Canton/DAML (off-chain)     │
└──────────────────────────────────────────────────────────────────┘
```

### Capital Flow — Module 1

```
User creates offer
    → LoanFactory.createLoan()
    → IYieldAdapter.deposit()        (funds earn yield while unmatched)
    → ParthenonOptimizer.deposit()
    → ParthenonPool.supply()

Offer matched or cancelled
    → LoanFactory.takeUpLoan() / cancelLoan()
    → IYieldAdapter.withdraw()       (returns principal + yield)
    → ParthenonOptimizer.redeem()
    → ParthenonPool.withdraw()
```

### Capital Flow — Module 2

```
Borrower KYC'd → Orchestrator.authorizeBorrower()
Market created  → Orchestrator.createMarket()
Lenders deposit → CreditMarket.deposit()
Borrower draws  → CreditMarket.borrow()
Lender redeems  → CreditMarket.requestWithdrawal() → claimWithdrawal()
Canton sync     → TICSBridge (relayer attests EVM ↔ Canton state)
```

---

## Core Types & Structs

Struct and enum definitions referenced throughout the docs. These live in interface files and libraries.

### Module 1 Structs (from `ILoanFactory.sol`)

```solidity
enum Status { s1, s2, s3, s4 }

struct Loan {
    uint256 id;
    uint256 startTime;
    uint256 asset;
    uint256 collateral;
    uint256 initialCollateralRatio;
    uint256 liquidationThreshold;
    address lender;
    address borrower;
    address assetAddress;
    address collateralAddress;
    uint8   rateIndex;
    uint8   durationIndex;
    Status  s;
}
```

### Module 1 Structs (from `IAssetRegistry.sol`)

```solidity
struct Asset {
    string symbol;
    string feedKey;
    uint8  decimals;
    bool   isRegistered;
    bool   isSupported;
}
```

### Module 1 Structs (from `PriceOracle.sol`)

```solidity
struct FeedConfig {
    AggregatorV3Interface feed;
    uint256 maxStaleness;
    uint8   feedDecimals;
    bool    exists;
}
```

### Adapter Structs

```solidity
// ParthenonVaultAdapter.sol
struct VaultConfig {
    IBoringVault vault;
    ITeller      teller;
    IAccountant  accountant;
    bool         enabled;
}

// IMorpho.sol
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
```

### Pool Structs (from `IParthenonPool.sol`)

```solidity
type Id is bytes32;

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

struct Authorization {
    address authorizer;
    address authorized;
    bool    isAuthorized;
    uint256 nonce;
    uint256 deadline;
}

struct Signature { uint8 v; bytes32 r; bytes32 s; }
```

### Module 2 Types (from `CreditTypesLib.sol`)

```solidity
enum MarketStatus     { Active, Delinquent, Closed }
enum WithdrawalStatus { Pending, Expired, Processed, Claimed, Unpaid, ExpiryReached }
enum CreditTier       { TIER_1, TIER_2, TIER_3, TIER_4 }
enum Transferability   { NonTransferable, KnownLendersOnly, Unrestricted }
enum BorrowerStatus   { PendingKYC, Approved, Suspended }

struct MarketParameters {
    uint16  annualInterestBips;
    uint16  delinquencyFeeBips;
    uint32  withdrawalBatchDuration;
    uint16  reserveRatioBips;
    uint32  delinquencyGracePeriod;
    uint16  protocolFeeBips;
    uint32  maxDelinquencyPeriod;
    uint128 maxTotalSupply;
    uint32  maturityDate;
    bytes32 gmslaRefHash;
    uint16  collateralRatioBps;
}

struct CreditMarketState {
    bool    isClosed;
    bool    isDelinquent;
    uint112 scaleFactor;
    uint32  lastInterestAccruedTimestamp;
    uint104 scaledTotalSupply;
    uint104 scaledPendingWithdrawals;
    uint32  pendingWithdrawalExpiry;
    uint16  _reserved;
    uint128 normalizedUnclaimedWithdrawals;
    uint128 accruedProtocolFees;
    uint32  timeDelinquent;
    uint16  annualInterestBips;
    uint16  delinquencyFeeBips;
    uint16  reserveRatioBips;
    uint16  protocolFeeBips;
    uint32  delinquencyGracePeriod;
    uint32  maxDelinquencyPeriod;
    uint128 maxTotalSupply;
    uint128 totalBorrowed;
    bool    isMatured;
    bool    isLiquidating;
    uint32  marginCallTimestamp;
    uint32  marginCallDeadline;
}

struct BorrowerAuth {
    BorrowerStatus status;
    CreditTier     tier;
    uint128        creditLimit;
    uint128        totalBorrowed;
    uint64         kycVerifiedAt;
    uint64         kycExpiresAt;
}
```

### Module 2 Structs (from `CreditMarket.sol`)

```solidity
struct WithdrawalBatch {
    uint104 scaledTotalAmount;
    uint104 scaledAmountBurned;
    uint128 normalizedAmountPaid;
}

struct AccountWithdrawalStatus {
    uint104 scaledAmount;
    uint128 normalizedAmountWithdrawn;
}
```

### Module 2 Structs (from `TICSBridge.sol` / `ITICSBridge.sol`)

```solidity
enum CollateralStatus { None, Reserved, Locked, Liquidating, Released }

struct CollateralState {
    CollateralStatus status;
    uint256          amount;
    bytes32          lockId;
    uint256          lastUpdated;
}
```

---

## Module 1 — P2P Lending

---

### LoanFactory

**File:** `contracts/LoanFactory.sol`

The core P2P lending engine. Manages fixed-rate loan offers (lend and borrow sides), collateral requirements, matching, liquidations, and fee collection. When an offer is unmatched, idle funds are routed to the `yieldAdapter` to earn passive yield.

Uses `require()` strings for validation — no custom errors.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `loanCounter` | `uint256` (private) | Auto-incrementing loan ID |
| `oracle` | `PriceOracle` (immutable) | Chainlink price oracle |
| `assetRegistry` | `IAssetRegistry` (immutable) | Token whitelist and pair validation |
| `protocolFeeBps` | `uint256` | Protocol fee in bps (max 500 = 5%) |
| `feeRecipient` | `address` | Address receiving protocol fees |
| `yieldAdapter` | `IYieldAdapter` | Active yield adapter (swappable) |
| `loans` | `mapping(uint256 => Loan)` | Loan ID → Loan struct |

#### Constants

| Constant | Value | Meaning |
|---|---|---|
| `DURATION_DAYS` | `[1, 7, 30, 90, 180, 365]` | Allowed loan durations |
| `RATE_BPS` | `[400, 500, 600, 700, 800, 900, 1000, 1100]` | Allowed interest rates (4%–11%) |
| `MIN_ASSET_UNITS` | `100` | Minimum loan size floor |
| `MIN_LIQUIDATION_THRESHOLD_BPS` | `10000` | 100% |
| `MAX_LIQUIDATION_THRESHOLD_BPS` | `15000` | 150% |
| `MIN_INITIAL_COLLATERAL_RATIO_BPS` | `11000` | 110% |
| `MAX_INITIAL_COLLATERAL_RATIO_BPS` | `50000` | 500% |
| `MAX_PROTOCOL_FEE_BPS` | `500` | 5% |

#### Functions

| Function | Access | Description |
|---|---|---|
| `createLoan(uint256 _asset, uint256 _collateral, uint256 _initialCollateralRatio, uint256 _liquidationThreshold, address _assetAddress, address _collateralAddress, uint8 _rateIndex, uint8 _durationIndex) → uint256` | External, whenNotPaused | Creates a lend or borrow offer. Deposits funds into yield adapter. Returns loan ID. |
| `cancelLoan(uint256 id)` | External | Cancels unmatched offer, withdraws from yield adapter, returns funds to creator. |
| `takeUpLoan(uint256 takeUpId, uint256 offerId)` | External, whenNotPaused | Matches two compatible offers. Withdraws idle funds from adapter before settling. |
| `liquidateLoan(uint256 id)` | External | Liquidates loan if health factor falls below liquidation threshold. |
| `endLoan(uint256 id)` | External | Ends a matured loan, splits collateral between lender and borrower. |
| `interruptLoan(uint256 id)` | External | Borrower ends loan early but pays full-term interest. |
| `topUp(uint256 id, uint256 additionalCollateral)` | External | Borrower adds collateral to improve health factor. |
| `setProtocolFee(uint256 _feeBps)` | Owner | Updates protocol fee (max 500 bps). |
| `setFeeRecipient(address _recipient)` | Owner | Updates fee recipient address. |
| `setYieldAdapter(address _adapter)` | Owner | Sets or clears the yield adapter. |
| `setMorphoAdapter(address _adapter)` | Owner | Backwards-compatible alias for `setYieldAdapter`. |
| `pause()` | Owner | Pauses loan creation and matching. |
| `unpause()` | Owner | Unpauses protocol. |

All state-changing functions use `nonReentrant`.

#### Events

| Event | Description |
|---|---|
| `Created(uint256 indexed id, address indexed creator, uint256 amount, Status s, uint256 rate, uint256 duration)` | New offer created |
| `Cancelled(address indexed canceller, Status s)` | Offer cancelled |
| `TakeUp(address indexed borrower, address indexed lender)` | Offer matched |
| `Liquidated(address indexed liquidator)` | Loan liquidated |
| `Ended(address indexed ender)` | Loan ended at maturity |
| `Interrupted(address indexed borrower)` | Loan interrupted early |
| `ToppedUp(address indexed borrower)` | Collateral added |
| `ProtocolFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps)` | Fee changed |
| `FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient)` | Recipient changed |
| `YieldAdapterUpdated(address indexed oldAdapter, address indexed newAdapter)` | Adapter swapped |
| `YieldSurplus(uint256 indexed loanId, address indexed recipient, address indexed token, uint256 amount)` | Yield returned to user |
| `FeeCollected(address indexed token, address indexed recipient, uint256 amount)` | Protocol fee taken |

---

### LoanCalculator (Library)

**File:** `contracts/libraries/LoanCalculator.sol`

Internal library used by `LoanFactory` for all math: repayment calculations, health score checks, and oracle price wrappers. All functions are `internal` — not callable externally.

#### Constants

| Constant | Value |
|---|---|
| `PRECISION` | `1e18` |

#### Functions

| Function | Visibility | Description |
|---|---|---|
| `pow(uint256 base, uint256 exponent)` | internal pure | Integer exponentiation. |
| `getOraclePrice(...)` | internal | Wraps `PriceOracle.getOraclePrice()` with circuit breaker. |
| `getInverseOraclePrice(...)` | internal | Wraps `PriceOracle.getInverseOraclePrice()`. |
| `getOraclePriceUnchecked(...)` | internal view | Price without circuit breaker (liquidations). |
| `getInverseOraclePriceUnchecked(...)` | internal view | Inverse without circuit breaker. |
| `calculateTotalRepayment(uint256 principal, uint256 rateBps, uint256 durationDays)` | internal pure | Total owed at maturity (principal + interest). |
| `calculateProratedRepaymentHourly(uint256 principal, uint256 rateBps, uint256 hoursElapsed)` | internal pure | Prorated interest for early interruption. |
| `calculateHealthScore(uint256 collateralAmount, uint256 loanAmount, uint256 rateBps, uint256 hoursElapsed, address collateralAddress, uint8 assetDecimals, PriceOracle oracle)` | internal | Health factor = collateral value / outstanding debt. |
| `calculateBTCPayout(uint256 principal, uint256 rateBps, uint256 durationDays, uint256 collateralAmount, ...)` | internal | Collateral needed to cover loan + interest at maturity. |
| `calculateExcessCollateral(...)` | internal | Returns surplus collateral beyond what the loan requires. |
| `calculateHealthScoreUnchecked(...)` | internal view | Health score without circuit breaker. |
| `calculateExcessCollateralUnchecked(...)` | internal view | Excess collateral without circuit breaker. |

---

### AssetRegistry

**File:** `contracts/AssetRegistry.sol`

Maintains the whitelist of tokens and valid collateral/asset pairs. Prevents fake-token attacks by ensuring LoanFactory only processes known, approved assets.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `assetList` | `address[]` (private) | All registered asset addresses (append-only) |
| `assets` | `mapping(address => Asset)` (private) | Token metadata |
| `symbolToAddress` | `mapping(string => address)` (private) | Reverse lookup by symbol |
| `validPairs` | `mapping(address => mapping(address => bool))` | Valid collateral → asset combinations |

#### Functions

| Function | Access | Description |
|---|---|---|
| `registerAsset(address asset, string symbol, string feedKey, uint8 decimals)` | Owner | Registers a new token. |
| `setAssetSupported(address asset, bool supported)` | Owner | Enables or disables an asset. |
| `updateAsset(address asset, string symbol, string feedKey, uint8 decimals)` | Owner | Updates asset metadata. |
| `setPairSupported(address collateral, address asset, bool supported)` | Owner | Enables or disables a collateral/asset pair. |
| `getAssetByAddress(address asset) → Asset` | View | Returns asset metadata by address. |
| `getAssetBySymbol(string symbol) → Asset` | View | Returns asset metadata by symbol. |
| `getAllAssets() → address[]` | View | Returns all registered asset addresses. |
| `isSupported(address asset) → bool` | View | Checks if asset is registered and enabled. |
| `isValidPair(address collateral, address asset) → bool` | View | Checks if pair is whitelisted. |

#### Events

| Event | Description |
|---|---|
| `AssetRegistered(address indexed asset, string symbol, string feedKey, uint8 decimals)` | New asset added |
| `AssetSupportUpdated(address indexed asset, bool supported)` | Asset enabled/disabled |
| `AssetUpdated(address indexed asset, string symbol, string feedKey, uint8 decimals)` | Asset metadata updated |
| `PairSupportUpdated(address indexed collateral, address indexed asset, bool supported)` | Pair enabled/disabled |

---

### PriceOracle

**File:** `contracts/PriceOracle.sol`
**Implements:** `IPriceOracle` (`contracts/pool/interfaces/IPriceOracle.sol`)

Wraps Chainlink price feeds with safety checks: staleness detection, zero-price guard, L2 sequencer uptime check, and a circuit breaker that rejects prices deviating more than `maxDeviationBps` from the last known good price. Implements two-step ownership transfer.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `owner` | `address` | Contract owner |
| `pendingOwner` | `address` | Pending owner (two-step transfer) |
| `feeds` | `mapping(address => FeedConfig)` | Per-token Chainlink feed config |
| `sequencerUptimeFeed` | `AggregatorV3Interface` | L2 sequencer uptime feed |
| `maxDeviationBps` | `uint256` | Circuit breaker threshold (default 5000 = 50%) |
| `lastGoodPrice` | `mapping(address => uint256)` | Last accepted price per token |

#### Constants

| Constant | Value | Description |
|---|---|---|
| `SEQUENCER_GRACE_PERIOD` | `3600` | Wait 1 hour after sequencer restarts |
| `SEQUENCER_MAX_STALENESS` | `3600` | Sequencer feed max age |
| `MIN_DEVIATION_BPS` | `100` | Minimum 1% deviation threshold |

#### Functions

| Function | Access | Description |
|---|---|---|
| `setFeed(address token, address feed, uint256 maxStaleness)` | Owner | Configures a Chainlink price feed for a token. |
| `setSequencerUptimeFeed(address feed)` | Owner | Sets the L2 sequencer uptime feed. |
| `setMaxDeviation(uint256 newMaxDeviationBps)` | Owner | Updates circuit breaker threshold. |
| `transferOwnership(address newOwner)` | Owner | Proposes new owner (step 1 of two-step). |
| `acceptOwnership()` | Pending owner | Accepts ownership (step 2). |
| `getOraclePrice(uint256 amount, address tokenAddress, uint8 assetDecimals) → uint256` | External | Asset-denominated value of collateral. Updates `lastGoodPrice`. |
| `getInverseOraclePrice(uint256 assetAmount, address tokenAddress, uint8 assetDecimals) → uint256` | External | Collateral amount for a given asset value. Updates `lastGoodPrice`. |
| `getOraclePriceUnchecked(...)` | External view | Price without circuit breaker — used for liquidations/settlement. |
| `getInverseOraclePriceUnchecked(...)` | External view | Inverse price without circuit breaker. |
| `getOraclePriceView(...)` | View | Read-only price (no state changes). |
| `getInverseOraclePriceView(...)` | View | Read-only inverse price. |

#### Events

| Event | Description |
|---|---|
| `FeedUpdated(address indexed token, address indexed feed, uint256 maxStaleness, uint8 decimals)` | Feed configured |
| `SequencerFeedUpdated(address indexed feed)` | Sequencer feed set |
| `MaxDeviationUpdated(uint256 oldDeviation, uint256 newDeviation)` | Circuit breaker updated |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | Ownership completed |
| `OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner)` | Ownership proposed |

#### Errors

| Error | Description |
|---|---|
| `StalePrice(uint256 updatedAt, uint256 maxAge)` | Feed answer too old |
| `InvalidPrice(int256 price)` | Feed returned zero or negative |
| `SequencerDown()` | L2 sequencer is offline |
| `SequencerFeedStale(uint256 updatedAt, uint256 maxAge)` | Sequencer feed itself is stale |
| `GracePeriodNotOver(uint256 timeSinceUp, uint256 gracePeriod)` | Sequencer recently restarted, waiting grace period |
| `ZeroAddress()` | Feed address is zero |
| `Unauthorized()` | Caller is not owner |
| `FeedNotConfigured(address token)` | No feed set for token |
| `PriceDeviationTooLarge(uint256 oldPrice, uint256 newPrice, uint256 maxDeviationBps)` | Price moved too far from last good price |

---

## Yield Adapters

All adapters implement `IYieldAdapter`. The `LoanFactory` holds a single adapter reference that can be swapped by the owner.

---

### IYieldAdapter (Interface)

**File:** `contracts/interfaces/IYieldAdapter.sol`

The common interface all yield adapters must implement.

| Function | Description |
|---|---|
| `deposit(address token, uint256 amount, uint256 loanId)` | Deposits idle funds for a specific loan offer. |
| `withdraw(address token, uint256 loanId, address to) → uint256 assets` | Withdraws principal + accrued yield. Returns total assets received. |
| `hasMarket(address token) → bool` | Returns true if this adapter supports the given token. |
| `sharesOf(uint256 loanId, address token) → uint256` | Returns shares held for a specific loan position. |
| `totalActivePositions() → uint256` | Returns the total number of active positions across all tokens. |

---

### OptimizerAdapter

**File:** `contracts/adapters/OptimizerAdapter.sol`

**Status: Recommended**

Routes idle offer funds into `ParthenonOptimizer` (an ERC-4626 vault). The optimizer handles routing across `ParthenonPool` markets. Includes per-token market controls (pause/freeze/cap) and batch emergency withdrawals.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `loanFactory` | `address` (immutable) | Only address allowed to call deposit/withdraw |
| `optimizers` | `mapping(address => address)` | Token → ERC-4626 optimizer address |
| `marketConfigured` | `mapping(address => bool)` | Whether a market is configured |
| `marketPaused` | `mapping(address => bool)` | Whether deposits are paused |
| `marketFrozen` | `mapping(address => bool)` | Whether both deposits and withdrawals are frozen |
| `marketCap` | `mapping(address => uint256)` | Max total shares allowed (0 = no cap) |
| `totalShares` | `mapping(address => uint256)` | Total optimizer shares held per token |
| `sharesOf` | `mapping(uint256 => mapping(address => uint256))` | LoanId → token → shares |
| `activePositions` | `mapping(address => uint256)` | Active position count per token |
| `totalActivePositions` | `uint256` | Global active position count |
| `depositedAmount` | `mapping(uint256 => mapping(address => uint256))` | Original deposit per loanId/token |
| `totalDepositedAssets` | `mapping(address => uint256)` | Total deposited per token |

#### Constants

| Constant | Value |
|---|---|
| `MAX_BATCH_SIZE` | `50` |

#### Functions

| Function | Access | Description |
|---|---|---|
| `configureOptimizer(address token, address optimizer)` | Owner | Sets the ERC-4626 optimizer for a token. |
| `setMarketPaused(address token, bool paused)` | Owner | Pauses or unpauses new deposits. Withdrawals still work. |
| `setMarketCap(address token, uint256 cap)` | Owner | Sets max total shares cap. 0 = unlimited. |
| `setMarketFrozen(address token, bool frozen)` | Owner | Freezes market — blocks both deposits and withdrawals. |
| `deconfigureMarket(address token)` | Owner | Removes market configuration entirely. |
| `deposit(address token, uint256 amount, uint256 loanId)` | LoanFactory | Deposits into optimizer vault. Checks pause/freeze/cap. |
| `withdraw(address token, uint256 loanId, address to) → uint256` | LoanFactory | Redeems shares and sends assets to `to`. |
| `emergencyWithdraw(address token, uint256 loanId, address to) → uint256` | Owner | Force withdraws a single position regardless of freeze. |
| `batchEmergencyWithdraw(address token, uint256[] loanIds, address to) → uint256` | Owner | Batch emergency withdrawal (max 50 positions). |
| `hasMarket(address token) → bool` | View | Returns true if optimizer configured for token. |
| `getShares(uint256 loanId, address token) → uint256` | View | Returns shares held for a loan position. |
| `getPositionsByToken(address token) → uint256[]` | View | Returns all active loanIds for a token. |
| `getCreatedMarkets() → address[]` | View | Returns all configured tokens. |
| `estimatePositionValue(uint256 loanId, address token) → (uint256 estimated, uint256 deposited)` | View | Estimates current value and original deposit. |
| `getMarketInfo(address token) → (totalShares, cap, activePositions, paused, frozen, totalDeposited)` | View | Returns full market stats. |

#### Events

| Event | Description |
|---|---|
| `OptimizerConfigured(address indexed token, address indexed optimizer)` | Market configured |
| `MarketPauseToggled(address indexed token, bool paused)` | Pause status changed |
| `MarketCapSet(address indexed token, uint256 cap)` | Cap updated |
| `Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares)` | Deposit recorded |
| `Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Withdrawal recorded |
| `EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Emergency withdrawal |
| `MarketFreezeToggled(address indexed token, bool frozen)` | Freeze status changed |
| `MarketDeconfigured(address indexed token)` | Market removed |

---

### ParthenonVaultAdapter

**File:** `contracts/adapters/ParthenonVaultAdapter.sol`

**Status: Active**

Routes idle offer funds into **Parthenon Boring Vaults** (from the `parthenonfi-vaults` repo). Uses a Teller contract for deposits/withdrawals, and an Accountant contract for share price queries. Includes slippage protection (default 1%, max 10%).

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `loanFactory` | `address` (immutable) | Only address allowed to call deposit/withdraw |
| `vaults` | `mapping(address => VaultConfig)` | Token → vault configuration (see VaultConfig struct above) |
| `sharesOf` | `mapping(uint256 => mapping(address => uint256))` | LoanId → token → vault shares |
| `activePositions` | `mapping(address => uint256)` | Active position count per token |
| `totalActivePositions` | `uint256` | Global active position count |
| `slippageBps` | `uint256` (default 100) | Slippage tolerance in basis points |

#### Constants

| Constant | Value |
|---|---|
| `BPS` | `10000` (private) |

#### Functions

| Function | Access | Description |
|---|---|---|
| `configureVault(address asset, address vault, address teller, address accountant)` | Owner | Configures a Boring Vault for an asset. Cross-validates Teller→Vault→Accountant. |
| `disableVault(address asset)` | Owner | Disables vault for an asset. |
| `setSlippageBps(uint256 newSlippageBps)` | Owner | Updates slippage tolerance (max 1000 = 10%). |
| `deposit(address token, uint256 amount, uint256 loanId)` | LoanFactory | Deposits into Boring Vault via Teller. |
| `withdraw(address token, uint256 loanId, address to) → uint256` | LoanFactory | Withdraws from Boring Vault and sends to `to`. |
| `hasMarket(address token) → bool` | View | Returns true if vault configured for token. |
| `emergencyWithdraw(address token, uint256 loanId, address to) → uint256` | Owner | Force withdraws a position. |
| `previewWithdraw(uint256 loanId, address token) → uint256` | View | Previews withdrawal amount using current share price. |
| `getSharePrice(address token) → uint256` | View | Returns current share price via Accountant's `getRateInQuote()`. |

#### Events

| Event | Description |
|---|---|
| `VaultConfigured(address indexed asset, address vault, address teller, address accountant)` | Vault configured |
| `VaultDisabled(address indexed asset)` | Vault disabled |
| `SlippageUpdated(uint256 oldBps, uint256 newBps)` | Slippage updated |
| `Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares)` | Deposit recorded |
| `Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Withdrawal recorded |
| `EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Emergency withdrawal |

---

### MorphoAdapter

**File:** `contracts/adapters/MorphoAdapter.sol`

**Status: Deprecated — use OptimizerAdapter instead**

Routes idle funds directly into Morpho Blue markets. Kept for reference and migration support. Full feature set: per-market controls, batch operations, partial withdrawals, and position enumeration for safe migration via `getPositionsByToken()`.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `morpho` | `IMorpho` (immutable) | Morpho Blue contract |
| `loanFactory` | `address` (immutable) | Only address allowed to call deposit/withdraw |
| `markets` | `mapping(address => MarketParams)` | Token → Morpho market parameters |
| `marketConfigured` | `mapping(address => bool)` | Configuration flags |
| `marketPaused` | `mapping(address => bool)` | Pause flags |
| `marketCap` | `mapping(address => uint256)` | Deposit caps |
| `marketFrozen` | `mapping(address => bool)` | Freeze flags |
| `totalShares` | `mapping(address => uint256)` | Total Morpho shares held per token |
| `sharesOf` | `mapping(uint256 => mapping(address => uint256))` | LoanId → token → Morpho shares |
| `activePositions` | `mapping(address => uint256)` | Active position count per token |
| `totalActivePositions` | `uint256` | Global active position count |
| `depositedAmount` | `mapping(uint256 => mapping(address => uint256))` | Original deposit per loanId/token |
| `totalDepositedAssets` | `mapping(address => uint256)` | Total deposited per token |

#### Constants

| Constant | Value |
|---|---|
| `MAX_NB_OF_MARKETS` | `128` |
| `MAX_BATCH_SIZE` | `50` |

#### Functions

| Function | Access | Description |
|---|---|---|
| `configureMarket(address token, MarketParams params)` | Owner | Configures a Morpho Blue market. |
| `setMarketPaused(address token, bool paused)` | Owner | Pauses/unpauses deposits. |
| `setMarketCap(address token, uint256 cap)` | Owner | Sets deposit cap. |
| `setMarketFrozen(address token, bool frozen)` | Owner | Freezes/unfreezes market. |
| `setPauseStatusForAllMarkets(bool paused)` | Owner | Pauses/unpauses all markets at once. |
| `setFreezeStatusForAllMarkets(bool frozen)` | Owner | Freezes/unfreezes all markets at once. |
| `deconfigureMarket(address token)` | Owner | Removes market configuration. |
| `deposit(address token, uint256 amount, uint256 loanId)` | LoanFactory | Deposits into Morpho. |
| `withdraw(address token, uint256 loanId, address to) → uint256` | LoanFactory | Withdraws from Morpho. |
| `withdrawPartial(address token, uint256 loanId, uint256 sharesToWithdraw, address to) → uint256` | LoanFactory | Partial withdrawal. |
| `emergencyWithdraw(address token, uint256 loanId, address to) → uint256` | Owner | Emergency withdrawal. |
| `batchEmergencyWithdraw(address token, uint256[] loanIds, address to) → uint256` | Owner | Batch emergency (max 50). |
| `hasMarket(address token) → bool` | View | Checks market configuration. |
| `isMarketPaused(address token) → bool` | View | Checks pause status. |
| `getShares(uint256 loanId, address token) → uint256` | View | Gets shares held. |
| `getMarketParams(address token) → MarketParams` | View | Gets market parameters. |
| `getMarketInfo(address token) → (totalShares, cap, activePositions, paused, frozen, totalDeposited)` | View | Gets full market info. |
| `getPositionsByToken(address token) → uint256[]` | View | Returns all active loanIds — use for migration. |
| `getPositionCount(address token) → uint256` | View | Gets position count for a token. |
| `getDepositedAmount(uint256 loanId, address token) → uint256` | View | Gets original deposit amount. |
| `getCreatedMarkets() → address[]` | View | Gets all configured tokens. |
| `getMarketCount() → uint256` | View | Gets total number of markets. |
| `getTotalDepositedAssets(address token) → uint256` | View | Gets total deposits for a token. |
| `estimatePositionValue(uint256 loanId, address token) → (uint256 estimated, uint256 deposited)` | View | Estimates single position value. |
| `estimateMarketValue(address token) → (uint256 estimatedTotal, uint256 totalDeposited)` | View | Estimates total market value. |
| `getPositionInfo(uint256 loanId, address token) → (uint256 shares, uint256 deposited, bool isActive)` | View | Gets full position info. |
| `getAllMarketsInfo() → (tokens[], totalShares[], caps[], activePositions[], pausedFlags[], frozenFlags[], totalDeposited[])` | View | Batch query for all market stats. |
| `getBatchPositionInfo(address token, uint256[] loanIds) → (uint256[] shares, uint256[] deposited)` | View | Batch position info query. |

#### Events

| Event | Description |
|---|---|
| `MarketConfigured(address indexed token, MarketParams params)` | Market configured |
| `MarketPauseToggled(address indexed token, bool paused)` | Pause status changed |
| `MarketCapSet(address indexed token, uint256 cap)` | Cap updated |
| `Deposited(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares)` | Deposit recorded |
| `Withdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Withdrawal recorded |
| `EmergencyWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, address indexed to)` | Emergency withdrawal |
| `MarketFreezeToggled(address indexed token, bool frozen)` | Freeze status changed |
| `PartialWithdrawn(uint256 indexed loanId, address indexed token, uint256 assets, uint256 shares, uint256 remainingShares, address indexed to)` | Partial withdrawal |
| `AllMarketsPauseToggled(bool paused)` | All markets paused/unpaused |
| `AllMarketsFreezeToggled(bool frozen)` | All markets frozen/unfrozen |
| `MarketDeconfigured(address indexed token)` | Market removed |

---

## Yield Infrastructure

---

### ParthenonOptimizer

**File:** `contracts/optimizer/ParthenonOptimizer.sol`

An ERC-4626 vault that routes deposits across `ParthenonPool` markets (and optionally external vaults) via an ordered `supplyQueue`. Withdrawals iterate a `withdrawQueue` to raise liquidity. Inspired by MetaMorpho.

The `OptimizerAdapter` is the gateway from LoanFactory into this contract.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `parthenonPool` | `IParthenonPool` (immutable) | The ParthenonPool being managed |
| `_supplyQueue` | `Id[]` (private) | Ordered list of markets for deposits |
| `_withdrawQueue` | `Id[]` (private) | Ordered list of markets for withdrawals |
| `allocationCap` | `mapping(Id => uint256)` | Max assets per market |
| `isAllocatable` | `mapping(Id => bool)` | Whether a market can receive allocations |
| `fee` | `uint256` | Protocol fee, WAD-scaled (max 50%) |
| `feeRecipient` | `address` | Fee recipient |
| `guardian` | `address` | Emergency guardian address |
| `lastTotalAssets` | `uint256` | Last recorded total (for fee accrual) |

#### Constants

| Constant | Value |
|---|---|
| `MAX_FEE` | `0.5e18` (50%) |
| `MAX_QUEUE_LENGTH` | `30` |

#### Functions

| Function | Access | Description |
|---|---|---|
| `deposit(uint256 assets, address receiver) → uint256 shares` | Public (ERC-4626) | Deposits assets, mints shares. Routes through supplyQueue. |
| `mint(uint256 shares, address receiver) → uint256 assets` | Public (ERC-4626) | Mints exact shares. |
| `withdraw(uint256 assets, address receiver, address owner) → uint256 shares` | Public (ERC-4626) | Withdraws assets. Iterates withdrawQueue. |
| `redeem(uint256 shares, address receiver, address owner) → uint256 assets` | Public (ERC-4626) | Redeems exact shares. |
| `totalAssets() → uint256` | View | Sum of all market positions + idle balance. |
| `setSupplyQueue(Id[] newSupplyQueue)` | Owner | Updates the deposit routing order (max 30 markets). |
| `setWithdrawQueue(Id[] newWithdrawQueue)` | Owner | Updates the withdrawal routing order (max 30 markets). |
| `setAllocationCap(Id id, uint256 cap)` | Owner | Sets max allocation for a market. |
| `setFee(uint256 newFee)` | Owner | Sets fee (max 50%). |
| `setFeeRecipient(address newFeeRecipient)` | Owner | Sets fee recipient. |
| `setGuardian(address newGuardian)` | Owner | Sets emergency guardian. |
| `reallocate(Id[] withdrawIds, uint256[] withdrawAmounts, Id[] supplyIds, uint256[] supplyAmounts)` | External, nonReentrant | Reallocates capital across markets for yield optimization. |
| `pool() → address` | View | Returns ParthenonPool address. |
| `supplyQueue(uint256 index) → Id` | View | Returns market at index in supply queue. |
| `withdrawQueue(uint256 index) → Id` | View | Returns market at index in withdraw queue. |
| `supplyQueueLength() → uint256` | View | Returns supply queue length. |
| `withdrawQueueLength() → uint256` | View | Returns withdraw queue length. |

#### Events

| Event | Description |
|---|---|
| `SupplyQueueUpdated(address indexed caller, uint256 length)` | Supply queue changed |
| `WithdrawQueueUpdated(address indexed caller, uint256 length)` | Withdraw queue changed |
| `AllocationCapUpdated(Id indexed id, uint256 cap)` | Market cap updated |
| `FeeUpdated(uint256 newFee)` | Fee changed |
| `FeeRecipientUpdated(address indexed newFeeRecipient)` | Recipient changed |
| `GuardianUpdated(address indexed newGuardian)` | Guardian changed |
| `Reallocated(address indexed caller, Id[] supplyIds, uint256[] amounts)` | Capital reallocated |

---

### ParthenonPool

**File:** `contracts/pool/ParthenonPool.sol`

A Morpho Blue fork providing isolated lending markets. Each market is defined by a unique `MarketParams` struct (loan token, collateral token, oracle, IRM, LLTV). ParthenonOptimizer deposits into these markets to earn yield.

Key differences from Morpho Blue:
- `Ownable2Step` (two-step ownership)
- Custom `ReentrancyGuard` on all state-changing functions
- Callbacks renamed `onPool*` instead of `onMorpho*`

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `DOMAIN_SEPARATOR` | `bytes32` (immutable) | EIP-712 domain separator |
| `owner` | `address` | Contract owner |
| `pendingOwner` | `address` | Pending owner |
| `feeRecipient` | `address` | Interest fee recipient |
| `position` | `mapping(Id => mapping(address => Position))` | User positions per market |
| `market` | `mapping(Id => Market)` | Market state per market ID |
| `isIrmEnabled` | `mapping(address => bool)` | Enabled interest rate models |
| `isLltvEnabled` | `mapping(uint256 => bool)` | Enabled LLTV ratios |
| `isAuthorized` | `mapping(address => mapping(address => bool))` | Position management authorization |
| `nonce` | `mapping(address => uint256)` | EIP-712 signature nonces |
| `idToMarketParams` | `mapping(Id => MarketParams)` | Market ID → params |

#### Functions

| Function | Access | Description |
|---|---|---|
| `createMarket(MarketParams marketParams)` | External | Creates a new isolated lending market. |
| `supply(MarketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) → (uint256, uint256)` | External | Lend assets to a market. |
| `withdraw(MarketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) → (uint256, uint256)` | External | Withdraw lent assets. |
| `borrow(MarketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) → (uint256, uint256)` | External | Borrow from a market. |
| `repay(MarketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) → (uint256, uint256)` | External | Repay borrowed assets. |
| `supplyCollateral(MarketParams, uint256 assets, address onBehalf, bytes data)` | External | Deposit collateral. |
| `withdrawCollateral(MarketParams, uint256 assets, address onBehalf, address receiver)` | External | Withdraw collateral. |
| `liquidate(MarketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) → (uint256, uint256)` | External | Liquidates an undercollateralized position. |
| `flashLoan(address token, uint256 assets, bytes data)` | External | Flash borrow. Must be returned in same transaction. |
| `accrueInterest(MarketParams)` | External | Manually triggers interest accrual. |
| `setAuthorization(address authorized, bool isAuthorized)` | External | Delegates position management. |
| `setAuthorizationWithSig(Authorization, Signature)` | External | EIP-712 signed authorization. |
| `enableIrm(address irm)` | Owner | Whitelists an interest rate model. |
| `enableLltv(uint256 lltv)` | Owner | Whitelists a LLTV ratio. |
| `setFee(MarketParams, uint256 newFee)` | Owner | Sets fee for a market. |
| `setFeeRecipient(address newFeeRecipient)` | Owner | Sets fee recipient. |
| `transferOwnership(address newOwner)` | Owner | Proposes ownership transfer (step 1). |
| `acceptOwnership()` | Pending owner | Accepts ownership (step 2). |
| `extSloads(bytes32[] slots) → bytes32[]` | View | Reads arbitrary storage slots. |

All state-changing functions use `nonReentrant`.

#### Events (from `EventsLib`)

| Event | Description |
|---|---|
| `SetOwner(address indexed newOwner)` | Ownership accepted |
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` | Transfer proposed |
| `EnableIrm(address indexed irm)` | IRM whitelisted |
| `EnableLltv(uint256 indexed lltv)` | LLTV whitelisted |
| `SetFee(Id indexed id, uint256 newFee)` | Market fee set |
| `SetFeeRecipient(address indexed newFeeRecipient)` | Fee recipient changed |
| `CreateMarket(Id indexed id, MarketParams marketParams)` | Market created |
| `Supply(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)` | Assets supplied |
| `Withdraw(Id indexed id, address indexed caller, address indexed onBehalf, address receiver, uint256 assets, uint256 shares)` | Assets withdrawn |
| `Borrow(Id indexed id, address indexed caller, address indexed onBehalf, address receiver, uint256 assets, uint256 shares)` | Assets borrowed |
| `Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)` | Debt repaid |
| `SupplyCollateral(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets)` | Collateral supplied |
| `WithdrawCollateral(Id indexed id, address indexed caller, address indexed onBehalf, address receiver, uint256 assets)` | Collateral withdrawn |
| `Liquidate(Id indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)` | Position liquidated |
| `FlashLoan(address indexed caller, address indexed token, uint256 assets)` | Flash loan executed |
| `SetAuthorization(address indexed caller, address indexed authorizer, address indexed authorized, bool isAuthorized)` | Authorization changed |
| `IncrementNonce(address indexed caller, address indexed authorizer, uint256 newNonce)` | Nonce incremented |
| `AccrueInterest(Id indexed id, uint256 borrowRate, uint256 interest, uint256 feeShares)` | Interest accrued |

---

### FixedRateIrm

**File:** `contracts/pool/irm/FixedRateIrm.sol`

A simple fixed interest rate model for `ParthenonPool` markets. Returns a constant `ratePerSecond` regardless of market utilization.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `owner` | `address` | Contract owner |
| `ratePerSecond` | `uint256` | Fixed borrow rate per second |

#### Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_RATE_PER_SECOND` | `3_170_979_198` | ~10% APR cap |

#### Functions

| Function | Access | Description |
|---|---|---|
| `setRate(uint256 _ratePerSecond)` | Owner | Updates the fixed rate. |
| `setOwner(address _newOwner)` | Owner | Transfers ownership. |
| `borrowRate(MarketParams, Market) → uint256` | View (IIrm) | Returns the fixed rate. |
| `borrowRateView(MarketParams, Market) → uint256` | View (IIrm) | Same as `borrowRate`. |

#### Events

| Event | Description |
|---|---|
| `RateUpdated(uint256 oldRate, uint256 newRate)` | Rate changed |
| `OwnerUpdated(address indexed oldOwner, address indexed newOwner)` | Owner changed |

---

### PoolOracleAdapter

**File:** `contracts/pool/oracles/PoolOracleAdapter.sol`

Bridges `PriceOracle` to `ParthenonPool`'s expected oracle interface. Each adapter instance is deployed for a specific loan/collateral token pair.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `oracle` | `IPriceOracle` (immutable) | The PriceOracle contract |
| `loanToken` | `address` (immutable) | The loan token for this pair |
| `collateralToken` | `address` (immutable) | The collateral token for this pair |
| `loanTokenDecimals` | `uint8` (immutable) | Loan token decimals |
| `collateralTokenDecimals` | `uint8` (immutable) | Collateral token decimals |

#### Functions

| Function | Access | Description |
|---|---|---|
| `price() → uint256` | View | Returns collateral price in terms of loan token, scaled to `ORACLE_PRICE_SCALE`. |

---

## Module 2 — Credit Markets

---

### Orchestrator

**File:** `contracts/module2/Orchestrator.sol`

Central governance for Module 2. Authorizes KYC'd borrowers with credit tiers, deploys per-borrower `CreditMarket` instances, manages the lender registry, and enforces sanctions checks. Maps to the DAML `Module2.BorrowerAuthorization` template.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `protocolFeeRecipient` | `address` | Protocol fee recipient |
| `_borrowerAuths` | `mapping(address => BorrowerAuth)` (internal) | Borrower authorization records |
| `_markets` | `mapping(address => mapping(address => address))` (internal) | Borrower → asset → market address |
| `_knownLenders` | `mapping(address => mapping(address => bool))` (internal) | Market → lender → known flag |
| `_marketBorrower` | `mapping(address => address)` (internal) | Market → borrower (reverse lookup) |
| `ticsBridge` | `address` | TICS bridge address |
| `sanctionsSentinel` | `address` | Sanctions sentinel address |
| `priceFeedAdapter` | `address` | Price feed adapter address |

#### Credit Tiers (from `CreditTypesLib`)

| Tier | Meaning |
|---|---|
| `TIER_1` | Lowest credit limit |
| `TIER_2` | Low |
| `TIER_3` | Medium |
| `TIER_4` | Highest credit limit |

#### Functions

| Function | Access | Description |
|---|---|---|
| `authorizeBorrower(address borrower, CreditTier tier)` | Owner | KYC-approves a borrower with a credit tier. |
| `updateCreditTier(address borrower, CreditTier newTier)` | Owner | Adjusts a borrower's credit limit tier. |
| `suspendBorrower(address borrower)` | Owner | Pauses all activity for a borrower. |
| `reactivateBorrower(address borrower)` | Owner | Restores a suspended borrower. |
| `createMarket(address borrower, address asset, MarketParameters params) → address` | Owner, nonReentrant | Deploys a new `CreditMarket` + `LoanPositionToken`. Registers with TICSBridge. |
| `registerLender(address market, address lender)` | Owner | Adds a lender to the known lenders list. |
| `removeLender(address market, address lender)` | Owner | Removes a lender from known list. |
| `checkAndRecordBorrow(address market, uint256 amount)` | CreditMarket | Verifies borrow is within credit tier limit and records it. |
| `recordRepayment(address market, uint256 amount)` | CreditMarket | Records repayment to free up credit capacity. |
| `getBorrowerAuth(address borrower) → BorrowerAuth` | View | Returns borrower authorization record. |
| `isKnownLender(address market, address lender) → bool` | View | Checks if lender is registered for a market. |
| `getMarket(address borrower, address asset) → address` | View | Returns market address for a borrower/asset pair. |
| `setProtocolFeeRecipient(address newRecipient)` | Owner | Updates fee recipient. |
| `setTICSBridge(address bridge)` | Owner | Sets TICS bridge address. |
| `setSanctionsSentinel(address sentinel)` | Owner | Sets sanctions sentinel. |
| `setPriceFeedAdapter(address adapter)` | Owner | Sets price feed adapter. |

#### Events (from `CreditEvents`)

| Event | Description |
|---|---|
| `BorrowerAuthorized(address indexed borrower, uint8 creditTier)` | Borrower KYC approved |
| `CreditTierUpdated(address indexed borrower, uint8 oldTier, uint8 newTier)` | Tier changed |
| `BorrowerSuspended(address indexed borrower, string reason)` | Borrower suspended |
| `BorrowerReactivated(address indexed borrower)` | Borrower restored |
| `MarketCreated(address indexed market, address indexed borrower, address indexed asset, uint16 annualInterestBips, uint16 reserveRatioBips)` | Market deployed |
| `LenderRegistered(address indexed market, address indexed lender)` | Lender added |
| `LenderRemoved(address indexed market, address indexed lender)` | Lender removed |

#### Errors (from `CreditErrors`)

| Error | Description |
|---|---|
| `ZeroAddress()` | Zero address provided |
| `BorrowerNotApproved()` | Borrower not authorized |
| `MarketAlreadyExists()` | Market already deployed for this borrower/asset |
| `InvalidInterestRate()` | Rate out of range |
| `InvalidReserveRatio()` | Reserve ratio out of range |
| `InvalidBatchDuration()` | Batch duration invalid |
| `InvalidMaxDelinquencyPeriod()` | Delinquency period invalid |
| `InvalidCollateralRatio()` | Collateral ratio invalid |
| `InvalidMaturityDate()` | Maturity date invalid |
| `CreditLimitExceeded()` | Borrow exceeds tier limit |
| `AddressSanctioned()` | Address on sanctions list |

---

### CreditMarket

**File:** `contracts/module2/CreditMarket.sol`

A per-borrower, per-asset undercollateralized credit facility. Maps 1:1 to the DAML `Module2.Market` template — every function corresponds to a DAML choice. Uses **scale factor accounting** (RAY precision, like Aave) for interest accrual and a **FIFO withdrawal batch queue** for lender redemptions.

#### Key Concepts

- **Scale Factor** — starts at `RAY (1e27)`, only ever increases. All deposit balances are stored as `scaledAmount = rawAmount / scaleFactor`. When a lender withdraws, their `scaledAmount * currentScaleFactor` gives their final balance including interest.
- **Withdrawal Batch Queue** — lenders queue withdrawals into batches with a fixed expiry. After the batch expires, the borrower's held assets pay out the batch. This creates a DAML-compatible temporal flow.
- **Delinquency** — if the borrower's liquidity falls below `liquidityRequired`, a grace period starts. After the grace period, delinquency fees accrue.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `borrower` | `address` (immutable) | The borrower this market belongs to |
| `asset` | `address` (immutable) | ERC-20 token deposited/borrowed |
| `marketId` | `bytes32` (immutable) | `keccak256(borrower, asset)` |
| `positionToken` | `ILoanPositionToken` | ERC-20 representing lender claims |
| `orchestrator` | `address` (immutable) | Parent orchestrator |
| `_parameters` | `MarketParameters` (internal) | Market config (rates, ratios, durations) |
| `_state` | `CreditMarketState` (internal) | Live state (scaleFactor, totalSupply, etc.) |
| `_unpaidBatches` | `uint32[]` (internal) | FIFO queue of unpaid batch expiry timestamps |
| `_batches` | `mapping(uint32 => WithdrawalBatch)` (internal) | Batch data per expiry |
| `_accountStatuses` | `mapping(uint32 => mapping(address => AccountWithdrawalStatus))` (internal) | Per-lender status per batch |

#### Functions

| Function | Access | Description |
|---|---|---|
| `deposit(uint256 amount, address onBehalfOf) → uint256 scaledAmount` | External, nonReentrant | Deposits assets. Mints scaled position tokens. Accrues interest first. |
| `borrow(uint256 amount)` | Borrower only, nonReentrant | Borrows assets. Calls Orchestrator to enforce credit limit. |
| `repay(uint256 amount)` | External, nonReentrant | Repays borrowed assets. Accrues interest first. |
| `requestWithdrawal(uint256 scaledAmount)` | External, nonReentrant | Queues a withdrawal into the current or next batch. Burns scaled position tokens. |
| `processWithdrawalBatch()` | External, nonReentrant | Processes the oldest unpaid batch if it has expired. |
| `claimWithdrawal(uint32 batchExpiry) → uint256 amount` | External, nonReentrant | Claims lender's share from a processed batch. |
| `accrueInterest()` | External, nonReentrant | Manually accrues interest. Updates scale factor. Checks delinquency. |
| `closeMarket()` | Borrower, nonReentrant | Closes the market. Borrower must repay all debt first. |
| `marginCall()` | Protocol operator, nonReentrant | Issues margin call if borrower is delinquent past grace period. |
| `cure()` | External, nonReentrant | Cures active margin call by restoring required liquidity. |
| `liquidate()` | Protocol operator, nonReentrant | Initiates liquidation after margin call deadline expires. |
| `setPositionToken(address token)` | Orchestrator | Sets the position token (once only). |
| `getState() → CreditMarketState` | View | Returns live market state. |
| `getParameters() → MarketParameters` | View | Returns market configuration. |
| `totalSupply() → uint256` | View | Total normalized supply (deposits × scaleFactor). |
| `borrowableAssets() → uint256` | View | Assets available to borrow (excludes reserves). |
| `liquidityRequired() → uint256` | View | Minimum assets the market must hold at all times. |
| `isDelinquent() → bool` | View | True if liquidity < liquidityRequired. |

#### Events (from `CreditEvents`)

| Event | Description |
|---|---|
| `Deposit(address indexed market, address indexed lender, uint256 amount, uint256 scaledAmount)` | Deposit recorded |
| `Borrow(address indexed market, address indexed borrower, uint256 amount)` | Borrow recorded |
| `Repay(address indexed market, address indexed borrower, uint256 amount)` | Repayment recorded |
| `WithdrawalRequested(address indexed market, address indexed lender, uint256 amount, uint32 batchExpiry)` | Withdrawal queued |
| `WithdrawalBatchProcessed(address indexed market, uint32 batchExpiry, uint256 amountPaid, uint256 amountUnpaid)` | Batch processed |
| `WithdrawalClaimed(address indexed market, address indexed lender, uint256 amount)` | Withdrawal claimed |
| `WithdrawalAutoRefunded(address indexed market, address indexed lender, uint256 scaledAmount)` | Withdrawal auto-refunded |
| `InterestAccrued(address indexed market, uint256 baseInterestRay, uint256 delinquencyFeeRay, uint256 protocolFee, uint256 newScaleFactor)` | Interest accrued |
| `MarginCallIssued(address indexed market, address indexed borrower, uint256 deficit, uint32 deadline)` | Margin call triggered |
| `MarginCallCured(address indexed market, address indexed borrower)` | Margin call resolved |
| `LiquidationInitiated(address indexed market, address indexed borrower, uint256 totalDebt)` | Liquidation started |
| `MarketClosed(address indexed market, address indexed borrower, uint256 finalScaleFactor)` | Market closed |
| `DelinquencyStatusChanged(address indexed market, bool isDelinquent, uint32 timeDelinquent)` | Delinquency status changed |
| `ProtocolFeesWithdrawn(address indexed market, address indexed recipient, uint256 amount)` | Protocol fees withdrawn |

#### Errors (from `CreditErrors`)

| Error | Description |
|---|---|
| `ZeroAddress()` | Zero address provided |
| `ZeroAmount()` | Amount is zero |
| `UnauthorizedLender()` | Caller not a known lender |
| `UnauthorizedBorrower()` | Caller is not the borrower |
| `MarketClosed()` | Market is closed |
| `MarketMatured()` | Market has reached maturity |
| `MarketLiquidating()` | Market is in liquidation |
| `InvalidBatchDuration()` | Batch duration invalid |
| `InvalidMaxDelinquencyPeriod()` | Period invalid |
| `InvalidMaturityDate()` | Date invalid |
| `InvalidCollateralRatio()` | Ratio invalid |
| `DepositExceedsMaxSupply()` | Would exceed max supply cap |
| `InsufficientBorrowableLiquidity()` | Not enough available to borrow |
| `RepayExceedsDebt()` | Trying to repay more than owed |
| `NoPendingWithdrawalBatch()` | No batch to process |
| `WithdrawalBatchNotExpired()` | Batch hasn't expired yet |
| `MarketNotClosed()` | Market must be closed first |
| `MarginCallNotActive()` | No active margin call |
| `MarginCallNotExpired()` | Deadline hasn't passed |
| `NotDelinquent()` | Borrower is not delinquent |

---

### TICSBridge

**File:** `contracts/module2/TICSBridge.sol`

Synchronizes state between EVM `CreditMarket` contracts and Canton/DAML ledger entries. An off-chain relayer watches EVM events, submits DAML choices on Canton, then calls this contract to record the resulting state hash alongside a Canton ECDSA attestation.

#### How It Works

1. EVM event fires (e.g. `Borrow` on `CreditMarket`)
2. Off-chain relayer reads event, submits equivalent DAML choice on Canton
3. Canton produces an attestation (signed state hash)
4. Relayer calls `syncMarketState()` to record EVM state hash
5. Relayer calls `receiveAttestation()` with Canton attestation signature
6. `isInSync()` returns true when both hashes match

For collateral (RWA assets held in custody):

```
requestCollateralReserve() → Canton puts hold on RWA collateral
confirmReservation()       → Relayer confirms Canton acknowledged
confirmLock()              → Relayer confirms lock is active
confirmRelease()           → Relayer confirms collateral released
releaseTimedOutReservation() → Cleans up expired locks
```

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `_marketAddresses` | `mapping(bytes32 => address)` (internal) | Market ID → address |
| `_stateHashes` | `mapping(bytes32 => bytes32)` (internal) | Latest EVM state hash per market |
| `_attestationHashes` | `mapping(bytes32 => bytes32)` (internal) | Latest Canton attestation hash |
| `_attestationTimestamps` | `mapping(bytes32 => uint64)` (internal) | Attestation timestamps |
| `_lastNonce` | `mapping(bytes32 => uint256)` (internal) | Nonce per market (replay protection) |
| `relayer` | `address` | Authorized relayer |
| `trustedAttester` | `address` | ECDSA public key for Canton attestations |
| `collateralStates` | `mapping(bytes32 => CollateralState)` | Per-market collateral lifecycle state |

#### Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_ATTESTATION_AGE` | `3600` | Max age for valid attestation (1 hour) |
| `LOCK_TIMEOUT` | `1 hours` | Collateral lock timeout |
| `MAX_DIVERGENCE_AGE` | `1 hours` | Max age for sync check |

#### Functions

| Function | Access | Description |
|---|---|---|
| `registerMarket(bytes32 marketId, address marketAddr)` | Owner | Registers a market for state sync. |
| `syncMarketState(bytes32 marketId)` | Relayer/Owner, nonReentrant | Records a new EVM-side state hash. |
| `receiveAttestation(bytes32 marketId, bytes attestation)` | Relayer/Owner, nonReentrant | Validates and records Canton attestation. Checks ECDSA sig, nonce, staleness. |
| `requestCollateralReserve(bytes32 marketId, address borrower, uint256 amount)` | Relayer/Owner | Initiates a collateral hold request on Canton. |
| `signalMarginCall(bytes32 marketId, address borrower, uint256 deficit)` | Relayer/Owner | Signals margin call to Canton relayer. |
| `signalLiquidation(bytes32 marketId, address borrower, uint256 amount)` | Relayer/Owner | Signals liquidation to Canton relayer. |
| `confirmReservation(bytes32 marketId, bytes32 reservationId, uint256 amount)` | Relayer/Owner | Confirms Canton acknowledged the reservation. |
| `confirmLock(bytes32 marketId, bytes32 lockId, uint256 amount)` | Relayer/Owner | Confirms collateral is locked on Canton. |
| `confirmLiquidation(bytes32 marketId, bytes32 liquidationId, uint256 proceeds)` | Relayer/Owner | Confirms liquidation proceeds. |
| `confirmRelease(bytes32 marketId, bytes32 lockId, uint256 amount)` | Relayer/Owner | Confirms collateral released on Canton. |
| `releaseTimedOutReservation(bytes32 marketId)` | Relayer/Owner | Cleans up an expired collateral reservation. |
| `getMarketStateHash(bytes32 marketId) → bytes32` | View | Returns the last EVM state hash. |
| `getAttestationHash(bytes32 marketId) → bytes32` | View | Returns the last Canton attestation hash. |
| `getAttestationTimestamp(bytes32 marketId) → uint64` | View | Returns the attestation timestamp. |
| `getMarketAddress(bytes32 marketId) → address` | View | Returns the CreditMarket address for a market ID. |
| `getCollateralState(bytes32 marketId) → CollateralState` | View | Returns the collateral lifecycle state. |
| `getLastNonce(bytes32 marketId) → uint256` | View | Returns the last accepted nonce. |
| `isRegistered(bytes32 marketId) → bool` | View | Checks if market is registered. |
| `isInSync(bytes32 marketId) → bool` | View | True if EVM and Canton state hashes match and attestation is recent. |
| `setRelayer(address newRelayer)` | Owner | Updates authorized relayer. |
| `setTrustedAttester(address attester)` | Owner | Updates the ECDSA attester key. |

#### Events

| Event | Description |
|---|---|
| `MarketRegistered(bytes32 indexed marketId, address indexed market)` | Market registered |
| `StateSynced(bytes32 indexed marketId, bytes32 stateHash, uint256 timestamp)` | EVM state hash updated |
| `AttestationReceived(bytes32 indexed marketId, bytes32 attestationHash, uint256 timestamp)` | Canton attestation recorded |
| `RelayerUpdated(address indexed oldRelayer, address indexed newRelayer)` | Relayer changed |
| `TrustedAttesterUpdated(address indexed oldAttester, address indexed newAttester)` | Attester key changed |
| `CollateralReserveRequested(bytes32 indexed marketId, address indexed borrower, uint256 amount)` | Collateral hold requested |
| `CollateralLockConfirmed(bytes32 indexed marketId, bytes32 lockId, uint256 amount)` | Lock confirmed |
| `MarginCallTriggered(bytes32 indexed marketId, address indexed borrower, uint256 deficit)` | Margin call signaled |
| `LiquidationInstructed(bytes32 indexed marketId, address indexed borrower, uint256 amount)` | Liquidation signaled |
| `CollateralReleased(bytes32 indexed marketId, bytes32 lockId, uint256 amount)` | Collateral released |
| `CollateralReservationTimedOut(bytes32 indexed marketId, bytes32 lockId)` | Reservation timed out |

#### Errors

| Error | Description |
|---|---|
| `MarketNotRegistered()` | Market ID not registered |
| `MarketAlreadyRegistered()` | Market ID already exists |
| `UnauthorizedRelayer()` | Caller is not relayer or owner |
| `ZeroAddress()` | Zero address provided |
| `InvalidAttestationSignature()` | ECDSA signature invalid |
| `StaleAttestation()` | Attestation too old |
| `InvalidCollateralState()` | Wrong collateral state for operation |
| `StaleOrReplayedAttestation()` | Nonce replay or stale |
| `LockTimeoutNotReached()` | Lock timeout hasn't expired |

---

### LoanPositionToken

**File:** `contracts/module2/LoanPositionToken.sol`

A non-rebasing ERC-20 representing lender positions in a `CreditMarket`. Balances are stored as scaled amounts — multiply by `scaleFactor()` to get the current value including accrued interest. Transfer restrictions are configurable per market. Maps to the DAML `Module2.LenderPosition` template.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `market` | `address` (immutable) | Parent CreditMarket |
| `orchestratorAddr` | `address` (immutable) | Orchestrator address |
| `transferability` | `Transferability` | Transfer restriction mode |
| `custodianSignature` | `bytes32` | Institutional custodian signature |

#### Transferability Modes (from `CreditTypesLib`)

| Mode | Description |
|---|---|
| `NonTransferable` | No transfers allowed |
| `KnownLendersOnly` | Transfers only to Orchestrator-registered lenders |
| `Unrestricted` | Anyone can receive transfers |

#### Functions

| Function | Access | Description |
|---|---|---|
| `mint(address to, uint256 scaledAmount)` | CreditMarket | Mints scaled tokens to lender. |
| `burn(address from, uint256 scaledAmount)` | CreditMarket | Burns scaled tokens from lender. |
| `normalizedBalanceOf(address account) → uint256` | View | Returns balance x scaleFactor (current USD-equivalent value). |
| `scaleFactor() → uint256` | View | Returns current scale factor from parent CreditMarket. |
| `setTransferability(Transferability mode)` | External | Sets transfer restriction mode. |
| `setCustodianSignature(bytes32 sig)` | External | Sets institutional custodian signature. |
| Standard ERC-20 | — | `balanceOf`, `transfer`, `transferFrom`, `approve`, `allowance` |

#### Errors (from `CreditErrors`)

| Error | Description |
|---|---|
| `UnauthorizedLender()` | Caller not authorized |
| `ZeroAddress()` | Zero address |
| `TransfersDisabled()` | Transferability is NonTransferable |
| `LenderNotKnown()` | Recipient not in known lenders list |

---

### SanctionsSentinel

**File:** `contracts/module2/SanctionsSentinel.sol`

Checks addresses against a Chainalysis-compatible sanctions list. Supports per-address overrides for false positives. Used by `Orchestrator` to block sanctioned addresses from participating.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `sanctionsList` | `address` | External sanctions list contract |
| `_hasOverride` | `mapping(address => bool)` (internal) | Whether an address has a manual override |
| `_overrideValue` | `mapping(address => bool)` (internal) | The override value (true = sanctioned) |

#### Functions

| Function | Access | Description |
|---|---|---|
| `isSanctioned(address addr) → bool` | View | Checks if address is sanctioned (override first, then external list). |
| `overrideSanction(address addr, bool sanctioned)` | Owner | Manually override sanctions status for an address. |
| `setSanctionsList(address _sanctionsList)` | Owner | Updates the external sanctions list contract. |

#### Events (from `ISanctionsSentinel`)

| Event | Description |
|---|---|
| `SanctionOverride(address indexed addr, bool sanctioned)` | Override applied |
| `SanctionsListUpdated(address indexed sanctionsList)` | List contract changed |

---

### PriceFeedAdapter

**File:** `contracts/module2/PriceFeedAdapter.sol`

Wraps Chainlink v3 aggregators for Module 2 contracts. Simpler than `PriceOracle` — no circuit breaker or sequencer checks. Returns raw price and decimals. Used by `Orchestrator` for collateral valuation.

#### State Variables

| Variable | Type | Description |
|---|---|---|
| `_feeds` | `mapping(address => AggregatorV3Interface)` (internal) | Asset → Chainlink feed |
| `stalenessThreshold` | `uint256` | Max feed age in seconds (default 3600) |

#### Functions

| Function | Access | Description |
|---|---|---|
| `setFeed(address asset, address feed)` | Owner | Configures a price feed for an asset. |
| `getPrice(address asset) → (uint256 price, uint8 decimals)` | View | Returns the latest price and feed decimals. |
| `isStale(address asset) → bool` | View | Checks if the feed is older than `stalenessThreshold`. |
| `setStalenessThreshold(uint256 _seconds)` | Owner | Updates staleness threshold. |

#### Events (from `IPriceFeedAdapter`)

| Event | Description |
|---|---|
| `FeedUpdated(address indexed asset, address indexed feed)` | Feed configured |
| `StalenessThresholdUpdated(uint256 newThreshold)` | Threshold changed |

#### Errors

| Error | Description |
|---|---|
| `FeedNotSet(address asset)` | No feed configured for asset |
| `InvalidPrice(address asset, int256 price)` | Feed returned zero or negative |
| `ZeroAddress()` | Zero address provided |
| `InvalidThreshold()` | Threshold is zero |

---

## All Errors from `CreditErrors.sol`

Complete reference of every custom error available to Module 2 contracts:

```
MarketClosed, MarketNotClosed, MarketAlreadyExists, ZeroAmount,
DepositExceedsMaxSupply, InsufficientBorrowableLiquidity, InsufficientBalance,
RepayExceedsDebt, WithdrawalBatchNotExpired, NoPendingWithdrawalBatch,
UnauthorizedBorrower, UnauthorizedLender, BorrowerNotApproved, BorrowerSuspended,
LenderNotKnown, CreditLimitExceeded, InvalidCreditTier, TierDowngradeNotAllowed,
InvalidInterestRate, InvalidReserveRatio, InvalidDelinquencyFee, InvalidProtocolFee,
InvalidGracePeriod, InvalidBatchDuration, InvalidMaxDelinquencyPeriod,
InvalidMaturityDate, InvalidCollateralRatio, MarketMatured, InvalidAttestation,
StaleAttestation, BridgeNotRegistered, AddressSanctioned, MarginCallNotActive,
MarginCallNotExpired, MarketLiquidating, NotDelinquent, CurePeriodNotSet,
TransfersDisabled, ZeroAddress, AlreadyInitialized
```

---

## All Events from `CreditEvents.sol`

Complete reference of every event available to Module 2 contracts:

```
MarketCreated, MarketClosed, Deposit, WithdrawalRequested,
WithdrawalBatchProcessed, WithdrawalClaimed, WithdrawalAutoRefunded,
Borrow, Repay, InterestAccrued, DelinquencyStatusChanged,
ProtocolFeesWithdrawn, BorrowerAuthorized, BorrowerSuspended,
BorrowerReactivated, CreditTierUpdated, LenderRegistered, LenderRemoved,
MarginCallIssued, MarginCallCured, LiquidationInitiated,
MarketStateUpdated, AttestationReceived
```

---

## Deployment Order

```
 1. PriceOracle
 2. AssetRegistry
 3. LoanFactory(oracle, assetRegistry)
 4. ParthenonPool
 5. FixedRateIrm → ParthenonPool.enableIrm(fixedRateIrm)
 6. ParthenonPool.enableLltv(...)
 7. PoolOracleAdapter(priceOracle, loanToken, collateralToken)
 8. ParthenonPool.createMarket(marketParams)
 9. ParthenonOptimizer(parthenonPool, asset, name, symbol, owner)
10. ParthenonOptimizer.setSupplyQueue([marketId])
11. ParthenonOptimizer.setWithdrawQueue([marketId])
12. ParthenonOptimizer.setAllocationCap(marketId, cap)
13. OptimizerAdapter(loanFactory)
14. OptimizerAdapter.configureOptimizer(token, parthenonOptimizer)
15. LoanFactory.setYieldAdapter(optimizerAdapter)

-- Module 2 (independent) --
16. SanctionsSentinel(sanctionsList)
17. PriceFeedAdapter()
18. Orchestrator(feeRecipient)
19. TICSBridge(relayer, trustedAttester)
20. Orchestrator.setTICSBridge(ticsBridge)
21. Orchestrator.setSanctionsSentinel(sanctionsSentinel)
22. Orchestrator.setPriceFeedAdapter(priceFeedAdapter)
23. Orchestrator.authorizeBorrower(borrower, tier)
24. Orchestrator.createMarket(borrower, asset, params)
    → deploys CreditMarket + LoanPositionToken
    → registers with TICSBridge
```

---

## Key Design Patterns

**Adapter / Dependency Injection** — `LoanFactory` depends only on `IYieldAdapter`. The adapter can be swapped without touching lending logic.

**ERC-4626** — `ParthenonOptimizer` is a standard vault interface, making it composable with any ERC-4626-aware integrator.

**Check-Effects-Interactions (CEI)** — All adapter `withdraw()` functions clear state before calling external contracts.

**Share-Based Accounting** — Yield accrues via the share-to-asset exchange rate, not rebasing. `assets = shares x exchangeRate`.

**Scale Factor Accrual** — `CreditMarket` tracks interest with a RAY (1e27) precision scale factor, identical to Aave's approach. Prevents precision loss over long durations.

**Ownable2Step** — Every owner-governed contract uses two-step ownership transfers to prevent accidental owner loss.

**FIFO Withdrawal Batching** — `CreditMarket` processes withdrawals in temporal order, matching the DAML template's sequential choice model.

**Canton Parity** — Every `CreditMarket` function maps to a DAML choice. `TICSBridge` ensures the two ledgers stay in sync via ECDSA-verified attestations with nonce-based replay protection.
