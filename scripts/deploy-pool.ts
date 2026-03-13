/**
 * deploy-pool.ts
 *
 * Deploys the ParthenonPool stack:
 *   1. ParthenonPool(owner)
 *   2. FixedRateIrm(owner, ratePerSecond)  — 5% APR
 *   3. PoolOracleAdapter(priceOracle, loanToken, collateralToken)
 *   4. pool.enableIrm(irm)
 *   5. pool.enableLltv(80e16)
 *   6. pool.createMarket({loanToken, collateralToken, oracle, irm, lltv})
 *
 * Required env vars:
 *   PRIVATE_KEY        — deployer private key (0x-prefixed)
 *   SEPOLIA_URL        — RPC URL
 *   PRICE_ORACLE       — deployed PriceOracle address
 *   LOAN_TOKEN         — ERC-20 loan token address   (e.g. USDC on Sepolia)
 *   COLLATERAL_TOKEN   — ERC-20 collateral token address (e.g. WETH on Sepolia)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-pool.ts --network sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// 5% APR in per-second WAD rate: 5e16 / (365.25 * 86400)
const RATE_PER_SECOND = BigInt("1585489599"); // ~1.585e9

// 80% LLTV (WAD = 1e18)
const LLTV_80 = BigInt("800000000000000000");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`\nDeploying pool stack on network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const priceOracle = process.env.PRICE_ORACLE;
  const loanToken = process.env.LOAN_TOKEN;
  const collateralToken = process.env.COLLATERAL_TOKEN;

  if (!priceOracle || !loanToken || !collateralToken) {
    throw new Error("Missing env: PRICE_ORACLE, LOAN_TOKEN, COLLATERAL_TOKEN");
  }

  // 1. Deploy ParthenonPool
  console.log("\n1. Deploying ParthenonPool...");
  const ParthenonPool = await ethers.getContractFactory("ParthenonPool");
  const pool = await ParthenonPool.deploy(deployer.address);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`   ParthenonPool: ${poolAddress}`);

  // 2. Deploy FixedRateIrm (5% APR)
  console.log("\n2. Deploying FixedRateIrm (5% APR)...");
  const FixedRateIrm = await ethers.getContractFactory("FixedRateIrm");
  const irm = await FixedRateIrm.deploy(deployer.address, RATE_PER_SECOND);
  await irm.waitForDeployment();
  const irmAddress = await irm.getAddress();
  console.log(`   FixedRateIrm: ${irmAddress}`);
  console.log(`   Rate per second: ${RATE_PER_SECOND} (5% APR)`);

  // 3. Deploy PoolOracleAdapter
  console.log("\n3. Deploying PoolOracleAdapter...");
  const PoolOracleAdapter = await ethers.getContractFactory("PoolOracleAdapter");
  const oracle = await PoolOracleAdapter.deploy(priceOracle, loanToken, collateralToken);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log(`   PoolOracleAdapter: ${oracleAddress}`);
  console.log(`   PriceOracle: ${priceOracle}`);
  console.log(`   LoanToken: ${loanToken}`);
  console.log(`   CollateralToken: ${collateralToken}`);

  // 4. Enable IRM
  console.log("\n4. Enabling IRM on pool...");
  const enableIrmTx = await pool.enableIrm(irmAddress);
  await enableIrmTx.wait();
  console.log(`   IRM enabled: ${irmAddress}`);

  // 5. Enable LLTV (80%)
  console.log("\n5. Enabling 80% LLTV on pool...");
  const enableLltvTx = await pool.enableLltv(LLTV_80);
  await enableLltvTx.wait();
  console.log(`   LLTV enabled: ${LLTV_80} (80%)`);

  // 6. Create market
  console.log("\n6. Creating market...");
  const marketParams = {
    loanToken,
    collateralToken,
    oracle: oracleAddress,
    irm: irmAddress,
    lltv: LLTV_80,
  };
  const createTx = await pool.createMarket(marketParams);
  const receipt = await createTx.wait();
  console.log(`   Market created (tx: ${receipt?.hash})`);

  // Compute market ID (keccak256 of ABI-encoded MarketParams)
  const marketId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [loanToken, collateralToken, oracleAddress, irmAddress, LLTV_80]
    )
  );
  console.log(`   Market ID: ${marketId}`);

  // Save addresses
  const deployment = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    ParthenonPool: poolAddress,
    FixedRateIrm: irmAddress,
    PoolOracleAdapter: oracleAddress,
    marketId,
    marketParams,
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-pool.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${outFile}`);

  console.log("\n=== Pool Deployment Summary ===");
  console.log(`ParthenonPool:    ${poolAddress}`);
  console.log(`FixedRateIrm:     ${irmAddress}`);
  console.log(`PoolOracleAdapter: ${oracleAddress}`);
  console.log(`Market ID:        ${marketId}`);

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
