/**
 * DeployModule2.test.ts
 *
 * Deployment dry-run test for Module 2 stack.
 * Verifies that the full deployment flow works on hardhat network:
 *   1. Orchestrator deploys with correct fee recipient
 *   2. Borrower is authorized at the correct tier
 *   3. CreditMarket is created with correct parameters
 *   4. Lender is registered
 *   5. All contracts are functional post-deployment
 *
 * Run: npx hardhat test --grep 'Deploy Module 2'
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Deploy Module 2 — Dry Run", function () {
  async function deployFullStack() {
    const [deployer, lender2] = await ethers.getSigners();

    // ─── Mock asset token ───────────────────────────────────────────
    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", deployer.address, ethers.parseUnits("10000000", 18), 18,
    ]);
    await usdc.waitForDeployment();
    const usdcAddress = await usdc.getAddress();

    // ─── Step 1: Deploy Orchestrator ────────────────────────────────
    const orchestrator = await ethers.deployContract("Orchestrator", [deployer.address]);
    await orchestrator.waitForDeployment();
    const orchestratorAddress = await orchestrator.getAddress();

    // ─── Step 2: Authorize borrower (deployer = borrower on local) ──
    const borrowerTier = 1; // TIER_2
    await orchestrator.authorizeBorrower(deployer.address, borrowerTier);

    // ─── Step 3: Create market ──────────────────────────────────────
    const marketParams = {
      annualInterestBips: 500,
      delinquencyFeeBips: 1000,
      withdrawalBatchDuration: 604800,
      reserveRatioBips: 2000,
      delinquencyGracePeriod: 604800,
      protocolFeeBips: 100,
      maxDelinquencyPeriod: 2592000,
      maxTotalSupply: ethers.parseUnits("1000000", 18),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0,
    };

    const tx = await orchestrator.createMarket(deployer.address, usdcAddress, marketParams);
    const receipt = await tx.wait();

    const marketAddress = await orchestrator.getMarket(deployer.address, usdcAddress);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // ─── Step 4: Register lender (deployer = lender on local) ───────
    await orchestrator.registerLender(marketAddress, deployer.address);

    return {
      deployer, lender2, usdc, usdcAddress, orchestrator, orchestratorAddress,
      market, marketAddress, marketParams, receipt, borrowerTier,
    };
  }

  // ─── Orchestrator checks ──────────────────────────────────────────

  describe("Orchestrator", function () {
    it("deploys with correct fee recipient", async function () {
      const { orchestrator, deployer } = await loadFixture(deployFullStack);
      expect(await orchestrator.protocolFeeRecipient()).to.equal(deployer.address);
    });

    it("is owned by deployer", async function () {
      const { orchestrator, deployer } = await loadFixture(deployFullStack);
      expect(await orchestrator.owner()).to.equal(deployer.address);
    });
  });

  // ─── Borrower authorization checks ────────────────────────────────

  describe("Borrower Authorization", function () {
    it("borrower is authorized at TIER_2", async function () {
      const { orchestrator, deployer } = await loadFixture(deployFullStack);
      const auth = await orchestrator.getBorrowerAuth(deployer.address);
      expect(auth.status).to.equal(1); // Approved
      expect(auth.tier).to.equal(1);   // TIER_2
      expect(auth.creditLimit).to.equal(500_000n * ethers.parseEther("1"));
    });
  });

  // ─── Market checks ───────────────────────────────────────────────

  describe("CreditMarket", function () {
    it("market address is non-zero", async function () {
      const { marketAddress } = await loadFixture(deployFullStack);
      expect(marketAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("market has correct parameters", async function () {
      const { market, marketParams } = await loadFixture(deployFullStack);
      const params = await market.getParameters();
      expect(params.annualInterestBips).to.equal(marketParams.annualInterestBips);
      expect(params.delinquencyFeeBips).to.equal(marketParams.delinquencyFeeBips);
      expect(params.withdrawalBatchDuration).to.equal(marketParams.withdrawalBatchDuration);
      expect(params.reserveRatioBips).to.equal(marketParams.reserveRatioBips);
      expect(params.protocolFeeBips).to.equal(marketParams.protocolFeeBips);
      expect(params.maxTotalSupply).to.equal(marketParams.maxTotalSupply);
    });

    it("market state is initialized correctly", async function () {
      const { market } = await loadFixture(deployFullStack);
      const state = await market.getState();
      expect(state.isClosed).to.be.false;
      expect(state.isDelinquent).to.be.false;
      expect(state.scaledTotalSupply).to.equal(0);
      expect(state.totalBorrowed).to.equal(0);
    });

    it("deployer can deposit as lender", async function () {
      const { market, usdc, deployer, marketAddress } = await loadFixture(deployFullStack);
      const amount = ethers.parseUnits("10000", 18);

      await usdc.approve(marketAddress, amount);
      await market.deposit(amount, deployer.address);

      const supply = await market.totalSupply();
      expect(supply).to.be.greaterThan(0);
    });

    it("deployer can borrow after deposit", async function () {
      const { market, usdc, deployer, marketAddress } = await loadFixture(deployFullStack);
      const depositAmount = ethers.parseUnits("100000", 18);
      const borrowAmount = ethers.parseUnits("50000", 18);

      await usdc.approve(marketAddress, depositAmount);
      await market.deposit(depositAmount, deployer.address);
      await market.borrow(borrowAmount);

      const state = await market.getState();
      expect(state.totalBorrowed).to.be.greaterThan(0);
    });
  });

  // ─── Gas check ────────────────────────────────────────────────────

  describe("Gas", function () {
    it("createMarket gas is under 4M", async function () {
      const { receipt } = await loadFixture(deployFullStack);
      expect(receipt!.gasUsed).to.be.lessThan(4_000_000n);
    });
  });

  // ─── TICSBridge integration ───────────────────────────────────────

  describe("TICSBridge integration", function () {
    it("bridge can register and sync a deployed market", async function () {
      const { deployer, marketAddress, usdcAddress } = await loadFixture(deployFullStack);

      // Deploy bridge (relayer = deployer, attester = deployer for test)
      const bridge = await ethers.deployContract("TICSBridge", [deployer.address, deployer.address]);
      await bridge.waitForDeployment();

      const marketId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address"],
          [deployer.address, usdcAddress]
        )
      );

      await bridge.registerMarket(marketId, marketAddress);
      expect(await bridge.isRegistered(marketId)).to.be.true;

      await bridge.syncMarketState(marketId);
      const hash = await bridge.getMarketStateHash(marketId);
      expect(hash).to.not.equal(ethers.ZeroHash);
    });
  });
});
