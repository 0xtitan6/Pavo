/**
 * deploy-adapter.ts
 *
 * Deploys the OptimizerAdapter and wires it into LoanFactory:
 *   1. OptimizerAdapter(loanFactory)
 *   2. adapter.configureOptimizer(loanToken, optimizerAddress)
 *   3. loanFactory.setYieldAdapter(adapterAddress)  — only if caller is LoanFactory owner
 *
 * Required env vars:
 *   PRIVATE_KEY          — deployer private key (must be LoanFactory owner for step 3)
 *   SEPOLIA_URL          — RPC URL
 *   LOAN_FACTORY         — deployed LoanFactory address
 *   OPTIMIZER_ADDRESS    — deployed ParthenonOptimizer address
 *   LOAN_TOKEN           — ERC-20 loan token address
 *
 * Usage:
 *   npx hardhat run scripts/deploy-adapter.ts --network sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`\nDeploying adapter on network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const loanFactoryAddress = process.env.LOAN_FACTORY;
  const optimizerAddress = process.env.OPTIMIZER_ADDRESS;
  const loanToken = process.env.LOAN_TOKEN;

  if (!loanFactoryAddress || !optimizerAddress || !loanToken) {
    throw new Error("Missing env: LOAN_FACTORY, OPTIMIZER_ADDRESS, LOAN_TOKEN");
  }

  // 1. Deploy OptimizerAdapter
  console.log("\n1. Deploying OptimizerAdapter...");
  const OptimizerAdapter = await ethers.getContractFactory("OptimizerAdapter");
  const adapter = await OptimizerAdapter.deploy(loanFactoryAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`   OptimizerAdapter: ${adapterAddress}`);

  // 2. Configure optimizer vault for loan token
  console.log("\n2. Configuring optimizer vault for loan token...");
  const configureTx = await adapter.configureOptimizer(loanToken, optimizerAddress);
  await configureTx.wait();
  console.log(`   Optimizer configured: token=${loanToken} -> optimizer=${optimizerAddress}`);

  // 3. Wire adapter into LoanFactory (requires LoanFactory owner)
  console.log("\n3. Setting yield adapter on LoanFactory...");
  const loanFactory = await ethers.getContractAt(
    ["function setYieldAdapter(address) external", "function owner() external view returns (address)"],
    loanFactoryAddress
  );

  const loanFactoryOwner: string = await loanFactory.owner();
  if (loanFactoryOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.warn(
      `   WARNING: Deployer (${deployer.address}) is not LoanFactory owner (${loanFactoryOwner}).`
    );
    console.warn("   Skipping setYieldAdapter — run manually as owner.");
  } else {
    const setAdapterTx = await loanFactory.setYieldAdapter(adapterAddress);
    await setAdapterTx.wait();
    console.log(`   LoanFactory.yieldAdapter set to ${adapterAddress}`);
  }

  // Save addresses
  const deployment = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    OptimizerAdapter: adapterAddress,
    loanFactory: loanFactoryAddress,
    optimizer: optimizerAddress,
    loanToken,
    loanFactoryOwner,
    adapterWired: loanFactoryOwner.toLowerCase() === deployer.address.toLowerCase(),
  };

  const outDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-adapter.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to ${outFile}`);

  console.log("\n=== Adapter Deployment Summary ===");
  console.log(`OptimizerAdapter: ${adapterAddress}`);
  console.log(`LoanFactory:      ${loanFactoryAddress}`);
  console.log(`Optimizer:        ${optimizerAddress}`);
  console.log(`LoanToken:        ${loanToken}`);
  if (!deployment.adapterWired) {
    console.log("\nACTION REQUIRED: Run as LoanFactory owner:");
    console.log(`  loanFactory.setYieldAdapter(${adapterAddress})`);
  }

  return deployment;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
