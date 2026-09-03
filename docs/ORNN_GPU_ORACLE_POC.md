# Ornn Hourly GPU Oracle — POC Runbook

## Purpose

This POC prices tokenized GPU compute-hours as collateral. One unit of a GPU-hour
token represents one hour of a specific GPU model; its `PostedPriceFeed` answer is
the Ornn Compute Price Index (OCPI) value in USD per GPU-hour.

For example, when the H100 OCPI is `$2.74`, `100` H100-hour tokens have an oracle
value of `$274` before any loan collateral-ratio rules are applied.

## Price source

Use Ornn's **Current Price** endpoint, not its daily settled-index endpoint:

```text
GET https://api.ornnai.com/api/gpu/:gpuName
```

The endpoint supplies `index_value` and `last_updated`. OCPI values are calculated
from a rolling one-hour window of executed, on-demand GPU rentals and are expressed
in USD per GPU-hour.

Free GPU identifiers currently supported by the public endpoint:

- `H100 SXM`
- `H200`
- `B200`
- `A100 SXM4`
- `RTX 5090`

Useful references:

- [Ornn API documentation](https://dashboard.ornnai.com/docs)
- [OCPI methodology](https://data.ornn.com/methodology)
- [Ornn FAQ and licensing](https://data.ornn.com/faq)

## On-chain flow

```text
Ornn hourly current price
        │
        ▼
scripts/post-ornn-price.ts
  - rejects stale source timestamps
  - uses the authorised poster key
        │
        ▼
PostedPriceFeed (one feed per GPU type)
        │  AggregatorV3Interface
        ▼
PriceOracle
        │
        ▼
LoanFactory collateral valuation
```

`PostedPriceFeed` is deliberately generic. There is no separate `OrnnFeedAdapter`
contract required for this design.

## Timing and safety configuration

| Setting | POC value | Reason |
|---|---:|---|
| Poster cadence | `5 * * * *` | Fetch shortly after each hourly OCPI update. |
| `ORNN_MAX_SOURCE_AGE_SECONDS` | `5400` (90 minutes) | Refuse an upstream result that is too old to republish. |
| `PriceOracle.setFeed(..., maxStaleness)` | `7200` (2 hours) | Price-dependent loan actions fail closed after missed posts. |
| `PriceOracle.maxDeviationBps` | `5000` (50%) | Circuit breaker for unusually large one-update moves. |
| Feed decimals | `8` | Chainlink-compatible USD-feed convention. |

The market price has no fixed maximum hourly move. It can be unchanged across
updates or move substantially, so the POC uses both a source-age check and the
on-chain deviation circuit breaker.

## Poster configuration

Copy `.env.example` to `.env` and set the deployed feed addresses:

```shell
ORNN_FEEDS="H100 SXM=0xYourH100Feed,B200=0xYourB200Feed"
ORNN_MAX_SOURCE_AGE_SECONDS=5400
```

For a licensed endpoint, `ORNN_API_BASE_URL`, `ORNN_API_KEY`,
`ORNN_API_KEY_HEADER`, and `ORNN_API_KEY_PREFIX` can be set as documented in
`.env.example`.

Load the environment and post:

```shell
set -a && source .env && set +a
npx hardhat run scripts/post-ornn-price.ts --network localhost
```

The signer must be an authorised poster in each target `PostedPriceFeed`.

## Local frontend POC

Use a local Hardhat node for a browser-wallet demo (Hardhat's built-in
`localhost` network points at it — no extra `hardhat.config.ts` entry needed):

```shell
npx hardhat node
```

In a second terminal, deploy the full stack — AssetRegistry, PriceOracle,
LoanFactory, mock USDC/WBTC, and one compute-hour token + `PostedPriceFeed`
per OCPI GPU, seeded from Ornn's live current prices:

```shell
npx hardhat run scripts/deploy-local.ts --network localhost
```

The script mints test balances to the first three Hardhat accounts and writes a
contract-address manifest to `deployments/localhost.json` (same shape as the
frontend's `src/deployments/*.ts` deployment objects). It also prints the
`ORNN_FEEDS` value to use with the hourly poster against these feeds.

Configure MetaMask with:

| Field | Value |
|---|---|
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency | `ETH` |

Import a Hardhat development account into MetaMask for local ETH and test-token
balances. These accounts and funds exist only on the local node; never import or
use a real wallet private key for the POC.

Restarting `npx hardhat node` resets contracts, balances, and addresses unless the
local chain state is preserved separately — re-run `scripts/deploy-local.ts` after
a restart and reload the new manifest.

## Data-use note

Reading current OCPI data is technically distinct from publishing it. A public
Sepolia or mainnet `PostedPriceFeed` republishes Ornn data to third parties, so
obtain the applicable Ornn oracle/redistribution permission before operating a
public feed. A local-only POC keeps the demonstration on a private development
chain. See [Ornn's terms](https://data.ornn.com/terms).

## Validation completed

- The live H100 current-price endpoint returned a valid positive price and a fresh
  `last_updated` timestamp during development.
- `npx tsc --noEmit` passes.
- The `PostedPriceFeed` and GPU-compute collateral tests pass.
- `scripts/deploy-local.ts` deploys the full stack against a fresh chain, seeds
  all five GPU feeds from live OCPI prices, and writes the address manifest.
- `scripts/post-ornn-price.ts` supports `DRY_RUN=true` for inspecting proposed
  posts without sending transactions.

## Next steps

1. Point the frontend at `deployments/localhost.json` and demonstrate price
   updates, stale-price reverts, and a collateral liquidation in the UI
   (see `docs/FRONTEND_INTEGRATION.md`).
2. Configure the hourly poster cron against the deployed feeds.
3. Before any public deployment, move feed ownership and poster administration to
   appropriate multisig/operational accounts and obtain data-use permission.
