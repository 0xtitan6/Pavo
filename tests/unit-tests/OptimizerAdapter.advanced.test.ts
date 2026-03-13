import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("OptimizerAdapter advanced tests", function () {
  async function deployAdapterFixture() {
    const [owner, loanFactorySigner, user1] = await ethers.getSigners();

    const usdc = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("1000000", 6), 6
    ]);
    const wbtc = await ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, ethers.parseUnits("100", 8), 8
    ]);

    const pool = await ethers.deployContract("ParthenonPool", [owner.address]);

    const ratePerSecond = ethers.parseUnits("5", 16) / (365n * 86400n);
    const irm = await ethers.deployContract("FixedRateIrm", [owner.address, ratePerSecond]);

    await pool.enableIrm(await irm.getAddress());
    const lltv = ethers.parseUnits("80", 16);
    await pool.enableLltv(lltv);

    const oracle = await ethers.deployContract("MockPoolOracle", [50000n * 10n ** 34n]);

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await wbtc.getAddress(),
      oracle: await oracle.getAddress(),
      irm: await irm.getAddress(),
      lltv: lltv
    };

    await pool.createMarket(marketParams);

    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    ));

    const optimizer = await ethers.deployContract("ParthenonOptimizer", [
      await pool.getAddress(),
      await usdc.getAddress(),
      "ParthenonOptimizer USDC",
      "poUSDC",
      owner.address
    ]);

    await optimizer.setSupplyQueue([id]);
    await optimizer.setWithdrawQueue([id]);

    const adapter = await ethers.deployContract("OptimizerAdapter", [loanFactorySigner.address]);
    await adapter.configureOptimizer(await usdc.getAddress(), await optimizer.getAddress());

    await usdc.transfer(loanFactorySigner.address, ethers.parseUnits("500000", 6));
    await usdc.connect(loanFactorySigner).approve(await adapter.getAddress(), ethers.MaxUint256);

    return { pool, optimizer, adapter, usdc, wbtc, owner, loanFactorySigner, user1, id, irm, oracle, lltv, marketParams };
  }

  // ========================================================================
  // Batch Emergency Withdraw
  // ========================================================================

  describe("Batch Emergency Withdraw", function () {
    it("Should batch withdraw 3 positions successfully", async function () {
      const { adapter, usdc, loanFactorySigner, user1 } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("2000", 6), 2);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("3000", 6), 3);

      expect(await adapter.totalActivePositions()).to.equal(3);

      const balBefore = await usdc.balanceOf(user1.address);
      await adapter.batchEmergencyWithdraw(usdcAddr, [1, 2, 3], user1.address);
      const balAfter = await usdc.balanceOf(user1.address);

      expect(balAfter - balBefore).to.be.gte(ethers.parseUnits("5990", 6));
      expect(await adapter.totalActivePositions()).to.equal(0);
    });

    it("Should skip zero-share positions in batch", async function () {
      const { adapter, usdc, loanFactorySigner, user1 } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 3);

      expect(await adapter.totalActivePositions()).to.equal(2);

      // loanId 2 has no shares — should be skipped
      await adapter.batchEmergencyWithdraw(usdcAddr, [1, 2, 3], user1.address);

      expect(await adapter.totalActivePositions()).to.equal(0);
      expect(await usdc.balanceOf(user1.address)).to.be.gte(ethers.parseUnits("1990", 6));
    });

    it("Should revert with empty array", async function () {
      const { adapter, usdc, user1 } = await loadFixture(deployAdapterFixture);

      await expect(adapter.batchEmergencyWithdraw(await usdc.getAddress(), [], user1.address))
        .to.be.revertedWith("Empty loanIds array");
    });

    it("Should revert with batch size > MAX_BATCH_SIZE (50)", async function () {
      const { adapter, usdc, user1 } = await loadFixture(deployAdapterFixture);

      const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
      await expect(adapter.batchEmergencyWithdraw(await usdc.getAddress(), tooMany, user1.address))
        .to.be.revertedWith("Batch too large");
    });

    it("Should revert with zero address recipient", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

      await expect(adapter.batchEmergencyWithdraw(usdcAddr, [1], ethers.ZeroAddress))
        .to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should revert when called by non-owner", async function () {
      const { adapter, usdc, loanFactorySigner, user1 } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

      await expect(adapter.connect(user1).batchEmergencyWithdraw(usdcAddr, [1], user1.address))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("Should clear all state correctly after batch withdraw", async function () {
      const { adapter, usdc, loanFactorySigner, user1 } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("2000", 6), 2);

      await adapter.batchEmergencyWithdraw(usdcAddr, [1, 2], user1.address);

      expect(await adapter.totalActivePositions()).to.equal(0);
      expect(await adapter.activePositions(usdcAddr)).to.equal(0);
      expect(await adapter.totalShares(usdcAddr)).to.equal(0);
      expect(await adapter.sharesOf(1, usdcAddr)).to.equal(0);
      expect(await adapter.sharesOf(2, usdcAddr)).to.equal(0);
      expect(await adapter.depositedAmount(1, usdcAddr)).to.equal(0);
      expect(await adapter.depositedAmount(2, usdcAddr)).to.equal(0);
      expect(await adapter.totalDepositedAssets(usdcAddr)).to.equal(0);

      const positions = await adapter.getPositionsByToken(usdcAddr);
      expect(positions.length).to.equal(0);
    });
  });

  // ========================================================================
  // Deposit Cap Enforcement
  // ========================================================================

  describe("Deposit Cap Enforcement", function () {
    it("Should allow deposit when no cap is set (cap = 0)", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      expect(await adapter.marketCap(usdcAddr)).to.equal(0);

      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("100000", 6), 1))
        .to.not.be.reverted;
    });

    it("Should allow deposit when within cap", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // Set a generous cap in shares (ERC-4626 shares may be 18 decimals)
      const bigCap = ethers.parseUnits("1000000", 18);
      await adapter.setMarketCap(usdcAddr, bigCap);

      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1))
        .to.not.be.reverted;
    });

    it("Should revert deposit when cap exceeded", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // Set a tiny cap (1 share unit)
      await adapter.setMarketCap(usdcAddr, 1n);

      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1))
        .to.be.revertedWith("Market deposit cap exceeded");
    });

    it("Should allow first deposit but revert second when cap is filled", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // First deposit to discover the share amount
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
      const sharesAfterFirst = await adapter.totalShares(usdcAddr);

      // Set cap exactly at current shares
      await adapter.setMarketCap(usdcAddr, sharesAfterFirst);

      // Second deposit should revert
      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 2))
        .to.be.revertedWith("Market deposit cap exceeded");
    });

    it("Should allow more deposits after cap increase", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // Deposit and set cap at current level
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);
      const sharesAfterFirst = await adapter.totalShares(usdcAddr);
      await adapter.setMarketCap(usdcAddr, sharesAfterFirst);

      // Second deposit reverts
      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 2))
        .to.be.revertedWith("Market deposit cap exceeded");

      // Increase cap to allow more
      await adapter.setMarketCap(usdcAddr, sharesAfterFirst * 3n);

      // Now second deposit succeeds
      await expect(adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 2))
        .to.not.be.reverted;
    });
  });

  // ========================================================================
  // Market Deconfiguration
  // ========================================================================

  describe("Market Deconfiguration", function () {
    it("Should deconfigure when no active positions", async function () {
      const { adapter, usdc } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      expect(await adapter.hasMarket(usdcAddr)).to.be.true;

      await expect(adapter.deconfigureMarket(usdcAddr))
        .to.emit(adapter, "MarketDeconfigured")
        .withArgs(usdcAddr);

      expect(await adapter.hasMarket(usdcAddr)).to.be.false;
    });

    it("Should revert deconfiguration when active positions exist", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

      await expect(adapter.deconfigureMarket(usdcAddr))
        .to.be.revertedWith("Active positions exist for token");
    });

    it("Should revert deconfiguration when outstanding shares exist", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // Deposit creates both activePositions and totalShares
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 1);

      // First require triggers on activePositions > 0
      await expect(adapter.deconfigureMarket(usdcAddr))
        .to.be.revertedWith("Active positions exist for token");

      // Withdraw clears both — verify deconfigure then succeeds
      await adapter.connect(loanFactorySigner).withdraw(usdcAddr, 1, loanFactorySigner.address);
      expect(await adapter.totalShares(usdcAddr)).to.equal(0);
      await expect(adapter.deconfigureMarket(usdcAddr)).to.not.be.reverted;
    });

    it("Should reset all state on deconfiguration", async function () {
      const { adapter, usdc } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      // Set various state flags before deconfiguring
      await adapter.setMarketPaused(usdcAddr, true);
      await adapter.setMarketFrozen(usdcAddr, true);
      await adapter.setMarketCap(usdcAddr, 999n);

      await adapter.deconfigureMarket(usdcAddr);

      expect(await adapter.marketConfigured(usdcAddr)).to.be.false;
      expect(await adapter.optimizers(usdcAddr)).to.equal(ethers.ZeroAddress);
      expect(await adapter.marketPaused(usdcAddr)).to.be.false;
      expect(await adapter.marketFrozen(usdcAddr)).to.be.false;
      expect(await adapter.marketCap(usdcAddr)).to.equal(0);

      const markets = await adapter.getCreatedMarkets();
      const marketAddrs = markets.map((a: string) => a.toLowerCase());
      expect(marketAddrs).to.not.include(usdcAddr.toLowerCase());
    });

    it("Should allow reconfiguration with new optimizer after deconfigure", async function () {
      const { adapter, usdc, pool, owner, id } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.deconfigureMarket(usdcAddr);
      expect(await adapter.hasMarket(usdcAddr)).to.be.false;

      // Deploy a new optimizer
      const newOptimizer = await ethers.deployContract("ParthenonOptimizer", [
        await pool.getAddress(),
        usdcAddr,
        "ParthenonOptimizer USDC v2",
        "poUSDC2",
        owner.address
      ]);
      await newOptimizer.setSupplyQueue([id]);
      await newOptimizer.setWithdrawQueue([id]);

      // Reconfigure
      await adapter.configureOptimizer(usdcAddr, await newOptimizer.getAddress());
      expect(await adapter.hasMarket(usdcAddr)).to.be.true;
      expect(await adapter.optimizers(usdcAddr)).to.equal(await newOptimizer.getAddress());
    });

    it("Should revert deconfiguration of unconfigured token", async function () {
      const { adapter, wbtc } = await loadFixture(deployAdapterFixture);

      await expect(adapter.deconfigureMarket(await wbtc.getAddress()))
        .to.be.revertedWith("No optimizer for token");
    });
  });

  // ========================================================================
  // View Functions
  // ========================================================================

  describe("View Functions", function () {
    it("Should return correct loanIds from getPositionsByToken", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 10);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 20);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("1000", 6), 30);

      const positions = await adapter.getPositionsByToken(usdcAddr);
      expect(positions.length).to.equal(3);

      const posNums = positions.map((p: bigint) => Number(p));
      expect(posNums).to.include(10);
      expect(posNums).to.include(20);
      expect(posNums).to.include(30);
    });

    it("Should return configured tokens from getCreatedMarkets", async function () {
      const { adapter, usdc } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      const markets = await adapter.getCreatedMarkets();
      expect(markets.length).to.equal(1);
      expect(markets[0].toLowerCase()).to.equal(usdcAddr.toLowerCase());
    });

    it("Should return correct values from estimatePositionValue", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();
      const depositAmount = ethers.parseUnits("5000", 6);

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, depositAmount, 42);

      const [estimatedAssets, deposited] = await adapter.estimatePositionValue(42, usdcAddr);
      expect(deposited).to.equal(depositAmount);
      // No interest accrued yet, so estimated assets should be approximately equal
      expect(estimatedAssets).to.be.gte(depositAmount - ethers.parseUnits("1", 6));
      expect(estimatedAssets).to.be.lte(depositAmount + ethers.parseUnits("1", 6));
    });

    it("Should return correct state from getMarketInfo", async function () {
      const { adapter, usdc, loanFactorySigner } = await loadFixture(deployAdapterFixture);
      const usdcAddr = await usdc.getAddress();

      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("2000", 6), 1);
      await adapter.connect(loanFactorySigner).deposit(usdcAddr, ethers.parseUnits("3000", 6), 2);

      await adapter.setMarketCap(usdcAddr, 999999n);
      await adapter.setMarketPaused(usdcAddr, true);

      const [totalSh, cap, activePos, paused, frozen, totalDep] = await adapter.getMarketInfo(usdcAddr);

      expect(totalSh).to.be.gt(0);
      expect(cap).to.equal(999999n);
      expect(activePos).to.equal(2);
      expect(paused).to.be.true;
      expect(frozen).to.be.false;
      expect(totalDep).to.equal(ethers.parseUnits("5000", 6));
    });
  });
});
