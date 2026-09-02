# Pavo Contracts

Smart contracts for a peer-to-peer fixed-rate lending protocol where lenders deposit stablecoins and borrowers post collateral — from BTC and alt coins to tokenized GPU compute-hours and real-world assets.

## Overview

Pavo is a peer-to-peer marketplace for fixed-rate, fixed-duration loans. In contrast to pool-based protocols (Aave, Compound) with variable interest rates subject to manipulation, Pavo offers:

- **Fixed interest rates** impervious to third-party manipulation
- **Fixed durations** — from 1 day to 365 days
- **Peer-to-peer matching** on a first-come-first-served basis
- **Any collateral with a price feed** — crypto via Chainlink, and assets without a Chainlink feed (compute, RWAs) via `PostedPriceFeed`
- **Oracle safety checks** — staleness, zero-price, sequencer uptime, and a price-deviation circuit breaker on every collateral valuation
- **Token whitelisting** via `AssetRegistry` to prevent fake-token attacks
- **Performance guarantees** — probabilistic bounds on repayment and collateral return derived from a geometric random walk model of collateral valuation

Lenders and borrowers discover competitive rates through tâtonnement (competitive offer/cancel dynamics), rather than rates set by a central authority or utilization curve.

## Protocol

Anyone can post an **offer to lend** (deposit the asset, e.g. USDC) or an **offer to borrow** (deposit collateral). Offers are matched peer-to-peer. Once matched, the borrower receives the asset and the collateral is held in the contract.

At maturity, the lender is repaid in collateral equivalent to `(1 + r)^d * v` (principal + interest), and any excess collateral is returned to the borrower. If the collateral health score drops below the liquidation threshold before maturity, the lender may liquidate and claim all collateral.

## Collateral Types

Every collateral token needs three things: an ERC20 representation, an `AssetRegistry` entry, and a price feed registered in `PriceOracle`. The oracle only speaks `AggregatorV3Interface`, so where the price comes from is per-token:

| Class | Examples | Feed source |
|---|---|---|
| Majors | WBTC, WETH | Chainlink aggregator proxy, as-is |
| Alt coins | Any ERC20 with a Chainlink feed | Chainlink aggregator proxy, as-is |
| Compute | Tokenized GPU compute-hours (H100, H200, A100, RTX 5090, B200) | [`PostedPriceFeed`](contracts/PostedPriceFeed.sol) fed daily from [Ornn's Compute Price Index](https://data.ornn.com) (OCPI) by [scripts/post-ornn-price.ts](scripts/post-ornn-price.ts) |
| Real-world assets | Tokenized T-bills, commodities, invoices | `PostedPriceFeed` fed from the relevant index/NAV source, or any `AggregatorV3`-compatible RWA feed |

`PostedPriceFeed` is a generic poster-driven feed: an authorized poster pushes values sourced off-chain, guarded by sanity bounds on the feed and the oracle's deviation circuit breaker. Match `maxStaleness` to the source's cadence (e.g. ~26h for OCPI's daily 20:00 UTC settle vs. ~1h for Chainlink's BTC/USD heartbeat). Different collateral classes coexist in one deployment — a WBTC loan and a compute-hour loan can run concurrently in the same `LoanFactory` (see [tests/unit-tests/OrnnCompute.e2e.test.ts](tests/unit-tests/OrnnCompute.e2e.test.ts)).

Try the live demo (fetches real OCPI prices and runs the full onboarding + valuation flow):
```shell
npx hardhat run scripts/demo-ornn-oracle.ts
```

## Contracts

### [contracts/LoanFactory.sol](contracts/LoanFactory.sol)
Core contract managing the full loan lifecycle. Takes `PriceOracle` and `AssetRegistry` as constructor arguments.

| Function | Who | Whitepaper | Description |
|---|---|---|---|
| `createLoan` | Lender or Borrower | eq. 33–34, 40–41 | Post a lend offer (deposit the asset) or borrow offer (deposit collateral) |
| `cancelLoan` | Lender or Borrower | eq. 45–48 | Cancel an unmatched offer and reclaim deposited tokens |
| `takeUpLoan` | Lender or Borrower | eq. 35–38, 42–44 | Match two opposing offers into an active loan |
| `liquidateLoan` | Lender | eq. 56–58 | Liquidate when health score drops below threshold; lender claims all collateral |
| `endLoan` | Anyone | eq. 53–55 | Settle a matured loan — lender receives collateral payout, borrower receives excess collateral |
| `interruptLoan` | Borrower | eq. 49–52 | Repay early with full-term interest in the asset and reclaim collateral |
| `topUp` | Borrower | eq. 59–60 | Add collateral to improve health score |

### [contracts/PriceOracle.sol](contracts/PriceOracle.sol)
Wraps Chainlink price feeds with safety checks. Implements `ϕ_t(H_t, v)` from whitepaper equation 23.

| Feature | Description |
|---|---|
| Staleness check | Reverts if price is older than `maxStaleness` (e.g., heartbeat + 60s) |
| Zero/negative price guard | Reverts on invalid feed data |
| Sequencer uptime check | L2 sequencer check with 1-hour grace period (Arbitrum, Base) |
| Circuit breaker | Reverts if price moves more than `maxDeviationBps` (default 50%) between reads |
| View variants | `getOraclePriceView` / `getInverseOraclePriceView` for off-chain reads without state changes |
| Multi-token | Reads `decimals()` from the ERC20 token dynamically — supports WBTC (8 dec), WETH (18 dec), compute-hour tokens (18 dec), etc. |

### [contracts/PostedPriceFeed.sol](contracts/PostedPriceFeed.sol)
`AggregatorV3Interface`-compatible feed for assets without a Chainlink feed (compute indices, RWAs). Authorized posters push values sourced off-chain; `PriceOracle` consumes it like any Chainlink feed.

| Feature | Description |
|---|---|
| Poster allowlist | Owner-managed set of addresses allowed to `postAnswer` |
| Sanity bounds | Optional min/max on posted values — catches fat-finger posts (e.g. $651 instead of $6.51) |
| Round history | Every post stored by round id, served via `getRoundData` |
| Fail-closed | Reverts (rather than returning zero) before the first post or for missing rounds |
| Two-step ownership | Same `transferOwnership`/`acceptOwnership` pattern as `PriceOracle` |

### [contracts/AssetRegistry.sol](contracts/AssetRegistry.sol)
Manages whitelisted tokens and valid collateral/asset pairs.

| Feature | Description |
|---|---|
| `registerAsset` | Register a token with symbol, Chainlink feed key, and decimals (validated against ERC20) |
| `setAssetSupported` | Enable or disable a token for new loans |
| `setPairSupported` | Whitelist a collateral/asset pair (e.g., WBTC/USDC) |
| `isValidPair` | Used by `LoanFactory` on every `createLoan` — blocks unlisted tokens |

### [contracts/libraries/LoanCalculator.sol](contracts/libraries/LoanCalculator.sol)
Pure math library implementing formulas from the Pavo whitepaper.

| Function | Formula | Description |
|---|---|---|
| `calculateTotalRepayment` | `(1 + r_daily)^d * v` | Total USDC repayment at maturity |
| `calculateHealthScore` | `ϕ_t(z) / ((1+r)^t * v)` in bps | Current collateral health (uses hours elapsed, not days) |
| `calculateBTCPayout` | `min(ϕ⁻¹((1+r)^d * v), z)` | BTC paid to lender at maturity |
| `calculateBTCPayout` (excess) | `z - btcPayout` | Excess BTC returned to borrower |

### [contracts/interfaces/ILoanFactory.sol](contracts/interfaces/ILoanFactory.sol)
Defines the `Loan` struct, `Status` enum, events, and function signatures.

### [contracts/interfaces/IAssetRegistry.sol](contracts/interfaces/IAssetRegistry.sol)
Interface for `AssetRegistry`.

### [contracts/deploy/DeployReference.sol](contracts/deploy/DeployReference.sol)
Reference deployment script with addresses for Ethereum mainnet, Sepolia, Arbitrum, Polygon, and Base. Includes a configuration checklist and an example Foundry deploy script.

## Loan Parameters

**Duration options** (index 0–5): 1, 7, 30, 90, 180, 365 days

**Interest rates** (index 0–7, annual): 4%, 5%, 6%, 7%, 8%, 9%, 10%, 11%

**Collateral constraints:**
- Liquidation threshold: 100%–150% (basis points: 10000–15000)
- Initial collateral ratio: 110%–500% (basis points: 11000–50000), must exceed liquidation threshold
- Minimum loan asset: 100 USDC
- Minimum collateral value: 100 USDC equivalent

## Loan States

```
s1 — offer to lend    (asset held in contract)
s2 — offer to borrow  (collateral held in contract)
s3 — active loan      (collateral held, asset sent to borrower)
s4 — terminated
```

## Health Score & Liquidation

The health score (whitepaper eq. 58) is:

```
health = ϕ_t(z) / ((1 + r)^t * v)   [in basis points]
```

where `ϕ_t(z)` is the live oracle value of the collateral in asset units and `(1 + r)^t * v` is the prorated loan value at time `t` (hours elapsed). Liquidation is allowed when `health < liquidationThreshold`, but only before maturity — after maturity, `endLoan` must be used for the fair collateral split.

## Deployment Order

```
1. Deploy AssetRegistry
2. registerAsset(WBTC, ...) + registerAsset(USDC, ...)
3. setAssetSupported(WBTC, true) + setAssetSupported(USDC, true)
4. setPairSupported(WBTC, USDC, true)
5. Deploy PriceOracle(owner)
6. oracle.setFeed(WBTC, CHAINLINK_BTC_USD, 3660)
7. Deploy LoanFactory(oracle, assetRegistry)
```

Onboarding additional collateral (compute, alt coins, RWAs) needs no redeploy — three owner transactions per token:

```
1. registerAsset(token, symbol, feedKey, decimals) + setAssetSupported(token, true)
2. setPairSupported(token, USDC, true)
3. oracle.setFeed(token, feed, maxStaleness)
   — feed = Chainlink proxy for crypto, or a PostedPriceFeed you deploy and post to
     (for compute: run scripts/post-ornn-price.ts on a daily cron after 20:00 UTC)
```

See [contracts/deploy/DeployReference.sol](contracts/deploy/DeployReference.sol) for chain-specific Chainlink addresses and a full Foundry deploy script example.

## Development

Install dependencies:
```shell
pnpm install
```

Compile contracts:
```shell
pnpm compile
```

Run tests:
```shell
pnpm test
```

Run tests with gas reporting:
```shell
REPORT_GAS=true pnpm test
```

Start a local node:
```shell
npx hardhat node
```

## Tech Stack

- [Hardhat](https://hardhat.org/) — development framework
- [OpenZeppelin Contracts v5](https://docs.openzeppelin.com/contracts/5.x/) — `SafeERC20`, `ReentrancyGuard`, `Ownable`, `Math`
- [Chainlink](https://docs.chain.link/) — `AggregatorV3Interface` price feeds
- Solidity `^0.8.28`
- TypeScript test suite with Chai
