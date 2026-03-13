# TICSBridge Keeper / Relayer Runbook

## 1. Overview

The TICSBridge keeper (relayer) is a background service that synchronizes state between the EVM smart contracts and the Canton/DAML ledger. It monitors on-chain events emitted by the `TICSBridge` contract and submits corresponding attestations to the Canton ledger, ensuring both systems maintain a consistent view of collateral reservations, locks, margin calls, liquidations, and releases.

The keeper is a critical piece of infrastructure. If it goes down or falls behind, the Canton ledger will not reflect on-chain state changes, potentially delaying collateral operations and margin call responses.

## 2. Architecture

```
EVM Chain (TICSBridge contract)
       |
       | Events (logs)
       v
  +-----------+
  |  Relayer  |  (this service)
  +-----------+
       |
       | gRPC / Ledger API
       v
Canton / DAML Ledger
```

**Flow:**

1. The relayer connects to an EVM RPC node and subscribes to `TICSBridge` contract events.
2. When an event is detected, the relayer parses the event data and constructs a corresponding Canton ledger command.
3. The relayer submits the command to the Canton ledger via the Ledger API.
4. For events that require an on-chain confirmation callback (e.g., collateral lock confirmed), the relayer calls the appropriate `TICSBridge` confirmation function after the Canton ledger acknowledges the command.

## 3. Events to Monitor

All events are emitted by the `TICSBridge` contract. The relayer must subscribe to and handle each of the following:

| Event | Description |
|---|---|
| `MarketRegistered(bytes32 indexed marketId, address indexed token, uint256 reserveRatioBips)` | A new lending market has been registered on the bridge. Relay market parameters to Canton so it can track the market. |
| `StateHashUpdated(bytes32 indexed marketId, bytes32 stateHash, uint256 timestamp)` | The canonical state hash for a market has been updated on-chain. Forward the new hash to Canton for reconciliation. |
| `CollateralReserveRequested(bytes32 indexed marketId, address indexed borrower, uint256 amount, uint256 requestId)` | A borrower has requested a collateral reservation. Canton must acknowledge and begin the reservation workflow. |
| `CollateralLockConfirmed(bytes32 indexed marketId, address indexed borrower, uint256 amount, uint256 requestId)` | Collateral has been locked on-chain. Notify Canton that the lock is confirmed so lending can proceed. |
| `MarginCallTriggered(bytes32 indexed marketId, address indexed borrower, uint256 deficit, uint256 deadline)` | A margin call has been triggered because available liquidity dropped below the required reserve. Canton must record the margin call and begin the cure period countdown. |
| `LiquidationInstructed(bytes32 indexed marketId, address indexed borrower, uint256 amount)` | The cure period expired without resolution. Liquidation has been instructed on-chain. Canton must update borrower state and begin liquidation processing. |
| `CollateralReleased(bytes32 indexed marketId, address indexed borrower, uint256 amount)` | Collateral has been released back to the borrower (e.g., after loan repayment or partial release). Update Canton records accordingly. |

## 4. Keeper Functions

These are the on-chain functions the relayer calls on the `TICSBridge` contract after receiving confirmation from the Canton ledger:

### `confirmReservation(bytes32 marketId, address borrower, uint256 requestId)`

Called after Canton acknowledges a `CollateralReserveRequested` event. Confirms that the reservation has been recorded on the Canton side, allowing the on-chain workflow to advance to the lock phase.

### `confirmLock(bytes32 marketId, address borrower, uint256 amount, uint256 requestId)`

Called after Canton confirms that collateral parameters are valid and the lock can proceed. This triggers the actual token lock in the bridge contract.

### `confirmLiquidation(bytes32 marketId, address borrower, uint256 amount)`

Called after Canton processes a liquidation instruction and determines the exact collateral to seize. Executes the liquidation on-chain, transferring collateral to the liquidator or protocol treasury.

### `confirmRelease(bytes32 marketId, address borrower, uint256 amount)`

Called after Canton approves a collateral release (e.g., loan fully repaid). Unlocks and returns collateral tokens to the borrower on-chain.

## 5. Environment Variables

| Variable | Description | Example |
|---|---|---|
| `RPC_URL` | EVM JSON-RPC endpoint (WebSocket recommended for event subscriptions) | `wss://mainnet.infura.io/ws/v3/<key>` |
| `PRIVATE_KEY` | Private key of the relayer EOA (must have ETH for gas) | `0xabc123...` |
| `TICS_BRIDGE_ADDRESS` | Deployed address of the TICSBridge contract | `0x1234...abcd` |
| `CANTON_LEDGER_URL` | Canton Ledger API gRPC endpoint | `https://canton.example.com:6865` |
| `POLL_INTERVAL` | Polling interval in milliseconds (used as fallback if WebSocket is unavailable) | `12000` |

## 6. Startup

Basic Node.js / ethers.js pattern for event listening:

```typescript
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const TICS_BRIDGE_ABI = [
  "event MarketRegistered(bytes32 indexed marketId, address indexed token, uint256 reserveRatioBips)",
  "event StateHashUpdated(bytes32 indexed marketId, bytes32 stateHash, uint256 timestamp)",
  "event CollateralReserveRequested(bytes32 indexed marketId, address indexed borrower, uint256 amount, uint256 requestId)",
  "event CollateralLockConfirmed(bytes32 indexed marketId, address indexed borrower, uint256 amount, uint256 requestId)",
  "event MarginCallTriggered(bytes32 indexed marketId, address indexed borrower, uint256 deficit, uint256 deadline)",
  "event LiquidationInstructed(bytes32 indexed marketId, address indexed borrower, uint256 amount)",
  "event CollateralReleased(bytes32 indexed marketId, address indexed borrower, uint256 amount)"
];

async function main() {
  const provider = new ethers.WebSocketProvider(process.env.RPC_URL!);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const bridge = new ethers.Contract(
    process.env.TICS_BRIDGE_ADDRESS!,
    TICS_BRIDGE_ABI,
    wallet
  );

  console.log(`Relayer started. Listening for TICSBridge events...`);
  console.log(`Bridge address: ${process.env.TICS_BRIDGE_ADDRESS}`);
  console.log(`Relayer address: ${wallet.address}`);

  bridge.on("MarketRegistered", async (marketId, token, reserveRatioBips, event) => {
    console.log(`MarketRegistered: ${marketId}`);
    // Forward to Canton ledger
  });

  bridge.on("CollateralReserveRequested", async (marketId, borrower, amount, requestId, event) => {
    console.log(`CollateralReserveRequested: market=${marketId} borrower=${borrower} amount=${amount}`);
    // 1. Submit reservation to Canton
    // 2. On Canton acknowledgment, call bridge.confirmReservation(marketId, borrower, requestId)
  });

  bridge.on("MarginCallTriggered", async (marketId, borrower, deficit, deadline, event) => {
    console.log(`MarginCallTriggered: market=${marketId} borrower=${borrower} deficit=${deficit}`);
    // Record margin call in Canton, start cure period monitoring
  });

  bridge.on("LiquidationInstructed", async (marketId, borrower, amount, event) => {
    console.log(`LiquidationInstructed: market=${marketId} borrower=${borrower} amount=${amount}`);
    // 1. Process liquidation in Canton
    // 2. Call bridge.confirmLiquidation(marketId, borrower, amount)
  });

  bridge.on("CollateralReleased", async (marketId, borrower, amount, event) => {
    console.log(`CollateralReleased: market=${marketId} borrower=${borrower} amount=${amount}`);
    // Update Canton records
  });

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("Shutting down relayer...");
    provider.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Relayer fatal error:", err);
  process.exit(1);
});
```

## 7. Error Recovery

### Missed Events

If the relayer goes down or disconnects, events emitted during the downtime will be missed by the WebSocket subscription. On restart:

1. Query the last processed block number from persistent storage (e.g., a local file or database).
2. Use `bridge.queryFilter(eventName, fromBlock, "latest")` to replay all missed events.
3. Process each event in order before resuming live subscription.

```typescript
// Example: replay missed events from last checkpoint
const lastBlock = loadCheckpoint(); // read from disk/db
const currentBlock = await provider.getBlockNumber();

for (const eventName of EVENT_NAMES) {
  const events = await bridge.queryFilter(eventName, lastBlock + 1, currentBlock);
  for (const event of events) {
    await processEvent(event);
  }
}

saveCheckpoint(currentBlock);
```

### RPC Failures

- Implement exponential backoff with jitter for RPC reconnection (starting at 1s, max 60s).
- Maintain a secondary RPC endpoint as fallback. If the primary WebSocket drops, switch to the fallback and fall back to polling mode using `POLL_INTERVAL`.
- Log all RPC errors with timestamps for post-incident analysis.

### Canton Ledger Unavailable

- Queue unprocessed events in memory (bounded buffer) or persist to disk.
- Retry Canton submissions with exponential backoff.
- Do NOT call on-chain confirmation functions until Canton has acknowledged the corresponding command.
- Alert the operator if the Canton backlog exceeds a configurable threshold.

### Idempotency

- Track processed `(event.transactionHash, event.logIndex)` pairs to avoid duplicate processing.
- All Canton commands and on-chain confirmations should be idempotent by design (duplicate calls are no-ops).

## 8. Gas Management

### Estimated Gas Per Function

| Function | Estimated Gas | Notes |
|---|---|---|
| `confirmReservation()` | ~80,000 | Storage write + event emission |
| `confirmLock()` | ~120,000 | Token transfer + storage updates |
| `confirmLiquidation()` | ~150,000 | Token transfer + state cleanup |
| `confirmRelease()` | ~120,000 | Token transfer + storage updates |

### Gas Buffer Strategy

1. **Pre-fund the relayer wallet** with enough ETH to cover at least 1,000 transactions at current gas prices. Monitor the balance and alert when it drops below 500 transactions worth.

2. **Use EIP-1559 fee estimation.** Set `maxFeePerGas` to 2x the current `baseFeePerGas` and `maxPriorityFeePerGas` to a reasonable tip (e.g., 1.5 gwei). This prevents overpaying during gas spikes while ensuring inclusion.

3. **Gas price ceiling.** Configure a maximum gas price threshold. If gas prices exceed this ceiling, queue the transaction and wait for prices to drop. Margin calls and liquidations should have a higher ceiling than routine state updates.

4. **Nonce management.** Track the nonce locally to avoid `nonce too low` errors when sending multiple transactions in rapid succession. Reset from `provider.getTransactionCount()` on startup or after errors.

5. **Stuck transaction recovery.** If a transaction is pending for more than N blocks (configurable, e.g., 20 blocks), resubmit with a 10% higher gas price using the same nonce to replace it.

```typescript
// Example: gas-aware transaction sending
async function sendWithGasBuffer(
  contract: ethers.Contract,
  method: string,
  args: any[],
  gasCeilingGwei: number = 100
) {
  const feeData = await contract.runner!.provider!.getFeeData();
  const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const ceilingWei = ethers.parseUnits(gasCeilingGwei.toString(), "gwei");

  if (maxFee > ceilingWei) {
    console.warn(`Gas price ${ethers.formatUnits(maxFee, "gwei")} gwei exceeds ceiling. Queuing.`);
    // Add to retry queue
    return;
  }

  const tx = await contract[method](...args, {
    maxFeePerGas: maxFee * 2n,
    maxPriorityFeePerGas: ethers.parseUnits("1.5", "gwei"),
  });

  console.log(`Sent ${method}: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed ${method} in block ${receipt!.blockNumber}, gas used: ${receipt!.gasUsed}`);
  return receipt;
}
```
