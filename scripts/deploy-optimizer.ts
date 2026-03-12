/**
 * deploy-optimizer.ts
 *
 * Deploys the ParthenonOptimizer:
 *   1. ParthenonOptimizer(pool, asset, name, symbol, owner)
 *   2. setSupplyQueue([marketId])
 *   3. setWithdrawQueue([marketId])
 *   4. setAllocationCap(marketId, cap)   — 0 = unlimited
 *
 * Required env vars:
 *   PRIVATE_KEY      — deployer private key
 *   SEPOLIA_URL      — RPC URL
 *   POOL_ADDRESS     — deployed ParthenonPool address
 *   LOAN_TOKEN       — asset token address (same as in pool market)
 *   MARKET_ID        — bytes32 market ID from deploy-pool output
 *
 * Optional env vars:
 *   ALLOCATION_CAP   — max assets for the market (default: 0 = unlimited)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-optimizer.ts --network sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`\nDeploying optimizer on network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const poolAddress = process.env.POOL_ADDRESS;
  const loanToken = process.env.LOAN_TOKEN;
  const marketId = process.env.MARKET_ID;

  if (!poolAddress || !loanToken || !marketId) {
    throw new Error("Missing env: POOL_ADDRESS, LOAN_TOKEN, MARKET_ID");
  }

  const allocationCap = BigInt(process.env.ALLOCATION_CAP ?? "0");

  // 1. Deploy ParthenonOptimizer
  console.log("\n1. Deploying ParthenonOptimizer...");
  const ParthenonOptimizer = await ethers.getContractFactory("ParthenonOptimizer");
  const optimizer = await ParthenonOptimizer.deploy(
    poolAddress,
    loanToken,
    "Parthenon Optimizer",
    "pOPT",
    deployer.address
  );
  await optimizer.waitForDeployment();
  const optimizerAddress = await optimizer.getAddress();
  console.log(`   ParthenonOptimizer: ${optimizerAddress}`);

  // 2. Set supply queue
  console.log("\n2. Setting supply queue...");
  const supplyQueueTx = await optimizer.setSupplyQueue([marketId]);
  await supplyQueueTx.wait();
  console.log(`   Supply queue set: [${marketId}]`);

  // 3. Set withdraw queue
  console.log("\n3. Setting withdraw queue...");
  const withdrawQueueTx = await optimizer.setWithdrawQueue([marketId]);
  await withdrawQueueTx.wait();
  console.log(`   Withdraw queue set: [${marketId}]`);

  // 4. Set allocation cap
  console.log("\n4. Setting allocation cap...");
  const capTx = await optimizer.setAllocationCap(marketId, allocationCap);
  await capTx.wait();
  console.log(`   Allocation cap: ${allocationCap === 0n ? "unlimited" : allocationCap.toString()}`);

  // Save addresses
  const deployment = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    ParthenonOptimizer: optimizerAddress,
    pool: poolAddress,
    asset: loanToken,
    marketId,
    allocationCap: allocationCap.toString(),
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-optimizer.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${outFile}`);

  console.log("\n=== Optimizer Deployment Summary ===");
  console.log(`ParthenonOptimizer: ${optimizerAddress}`);
  console.log(`Pool:               ${poolAddress}`);
  console.log(`Asset:              ${loanToken}`);
  console.log(`Market ID:          ${marketId}`);

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
