# Pavo Contracts — Frontend Integration Guide

How to run the Pavo contract stack locally and wire the frontend to it, including
the GPU compute-hour collateral markets priced by Ornn's Compute Price Index (OCPI).

## TL;DR — local stack in three commands

```shell
# in parthenonfi-contracts
pnpm install && pnpm compile
npx hardhat node                                          # terminal 1: local chain
npx hardhat run scripts/deploy-local.ts --network localhost   # terminal 2: deploy
```

`deploy-local.ts` deploys the full stack, seeds all five GPU price feeds from
Ornn's **live** hourly OCPI prices (offline fallbacks if the API is unreachable),
mints test balances to Hardhat accounts #0–#2, and writes
`deployments/localhost.json` — the address manifest the frontend loads.

Restarting `npx hardhat node` wipes everything: re-run the deploy script and
reload the new manifest.

## What gets deployed

| Contract | Purpose |
|---|---|
| `LoanFactory` | Core loan lifecycle: create/cancel/match/repay/liquidate/settle |
| `PriceOracle` | Collateral valuation with staleness + deviation circuit breaker |
| `AssetRegistry` | Token + collateral/asset pair whitelist |
| `MockUSDC` (6 dec) | Loan asset |
| `MockWBTC` (8 dec) + `BtcUsdFeed` | Majors collateral market ($109,000 mock feed) |
| 5 × GPU compute-hour tokens (18 dec) + 5 × `PostedPriceFeed` (8 dec) | Compute collateral markets |

GPU markets (one token = one hour of that GPU; oracle answer = USD per GPU-hour):

| Token symbol | GPU | Manifest keys |
|---|---|---|
| `H100H` | H100 SXM | `H100HToken`, `H100HFeed` |
| `H200H` | H200 | `H200HToken`, `H200HFeed` |
| `A100H` | A100 SXM4 | `A100HToken`, `A100HFeed` |
| `R5090H` | RTX 5090 | `R5090HToken`, `R5090HFeed` |
| `B200H` | B200 | `B200HToken`, `B200HFeed` |

Whitelisted pairs: `WBTC/USDC` plus each `<GPU>/USDC`.

## The address manifest

`deployments/localhost.json` matches the shape of the frontend's existing
`src/deployments/ethereum-sepolia.ts` deployment object:

```jsonc
{
  "network": "localhost",
  "chainId": 31337,
  "contracts": {
    "LoanFactory": "0x...",
    "PriceOracle": "0x...",
    "AssetRegistry": "0x...",
    "MockUSDC": "0x...",
    "MockWBTC": "0x...",
    "BtcUsdFeed": "0x...",
    "H100HToken": "0x...", "H100HFeed": "0x...",
    // ... one Token + Feed pair per GPU
  },
  "deployer": "0x...",
  "timestamp": "…",
  "pairs": ["WBTC/USDC", "H100H/USDC", "H200H/USDC", "A100H/USDC", "R5090H/USDC", "B200H/USDC"],
  "gpus": [
    { "name": "H100 SXM", "symbol": "H100H", "token": "0x...", "feed": "0x...", "price": 3.06, "live": true }
    // ...
  ]
}
```

The `gpus` array carries display metadata (full GPU name, seeded price, whether
it came from the live API) so the UI doesn't need to hardcode it.

## ⚠️ ABI: this repo's core contract is `LoanFactory`, not `ParthenonCore`

The frontend currently ships `src/abis/ParthenonCore.json` and
`PARTHENON_BOUNDS` (flexible bps rates, up to 730-day durations). **This repo's
`LoanFactory` has a different, index-based interface** — calls against it with
the ParthenonCore ABI will fail. After `pnpm compile`, take ABIs from:

```
artifacts/contracts/LoanFactory.sol/LoanFactory.json      → .abi
artifacts/contracts/PriceOracle.sol/PriceOracle.json      → .abi
artifacts/contracts/AssetRegistry.sol/AssetRegistry.json  → .abi
artifacts/contracts/PostedPriceFeed.sol/PostedPriceFeed.json → .abi
```

### LoanFactory parameters are indexes, not raw values

| Parameter | Values |
|---|---|
| Duration index 0–5 | 1, 7, 30, 90, 180, 365 days |
| Rate index 0–7 (annual) | 4%, 5%, 6%, 7%, 8%, 9%, 10%, 11% |
| Liquidation threshold | 10000–15000 bps (100%–150%) |
| Initial collateral ratio | 11000–50000 bps, must exceed liquidation threshold |
| Minimum loan / collateral value | 100 USDC equivalent |

### Core calls

| Function | Who | Notes |
|---|---|---|
| `createLoan(...)` | Lender or borrower | Deposits USDC (lend offer) or collateral (borrow offer); requires prior ERC20 `approve` to `LoanFactory` |
| `cancelLoan(loanId)` | Offer creator | Reclaims deposit while unmatched |
| `takeUpLoan(takeUpId, offerId)` | Counterparty | Matches an offer into an active loan |
| `interruptLoan(loanId)` | Borrower | Early repay (full-term interest, in USDC) |
| `topUp(loanId, amount)` | Borrower | Add collateral to improve health |
| `liquidateLoan(loanId)` | Lender | Allowed when health < liquidation threshold, before maturity only |
| `endLoan(loanId)` | Anyone | Settles a matured loan |

Loan statuses: `s1` offer-to-lend, `s2` offer-to-borrow, `s3` active, `s4` terminated.

### Read paths for the UI

- Collateral value in USDC: `PriceOracle.getOraclePriceView(amount, token, 6)`
  (view variant — no gas, no state). Inverse: `getInverseOraclePriceView`.
- Live GPU price: `PostedPriceFeed.latestRoundData()` — Chainlink
  `AggregatorV3Interface`, answer has 8 decimals.
- Health score: **not exposed as a contract view** — compute it client-side as
  `collateralValue / proratedLoanValue` in bps, where `collateralValue` comes
  from `getOraclePriceView(loan.collateral, token, 6)` and
  `proratedLoanValue = (1 + dailyRate)^(hoursElapsed/24) * principal`
  (mirrors `LoanCalculator.calculateHealthScore`). Liquidatable when below the
  loan's `liquidationThreshold`, before maturity only.

### Decimals cheat-sheet

| Asset | Decimals |
|---|---|
| USDC | 6 |
| WBTC | 8 |
| GPU compute-hour tokens | 18 |
| All price feeds | 8 |

## Chain + wallet setup

Add chain 31337 to the frontend's chain config (viem exports a ready-made
`hardhat` chain from `viem/chains`). MetaMask:

| Field | Value |
|---|---|
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency | `ETH` |

Import a Hardhat dev-account private key (printed by `npx hardhat node`) for
ETH + minted test tokens. These keys are public knowledge — never use them, or
any real key, outside the local node.

## Live price updates and failure modes to surface in the UI

Prices for GPU markets are pushed, not pulled: an authorized poster runs
`scripts/post-ornn-price.ts` hourly (the deploy script prints a ready-made
`ORNN_FEEDS` env value; `DRY_RUN=true` previews without transacting).

Two failure modes are deliberate and worth surfacing in the UI rather than as
generic errors:

- **Stale price (fail closed).** GPU feeds have a 2-hour `maxStaleness`. If no
  post lands for 2+ hours, every price-dependent action (`createLoan`,
  `takeUpLoan`, `liquidateLoan`, …) reverts until a fresh price is posted. On a
  local node you can trigger this with
  `evm_increaseTime`/`evm_mine` (advance > 2h).
- **Circuit breaker.** A posted price that moves > 50% from the last good price
  makes the oracle revert (`PriceDeviationTooLarge`).

To demo a liquidation locally: open a GPU-collateral loan near the liquidation
threshold, then post a lower price to that GPU's `PostedPriceFeed` (deployer is
an authorized poster) and call `liquidateLoan` as the lender.

## Licensing note

OCPI values come from Ornn's API. Republishing them through a **public**
on-chain feed requires Ornn's written data/redistribution permission — the
local-only POC is fine, but don't point a deployed testnet/mainnet poster at
the public endpoint without it. See `docs/ORNN_GPU_ORACLE_POC.md`.
