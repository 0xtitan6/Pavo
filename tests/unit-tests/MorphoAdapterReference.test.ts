import hre from "hardhat";
import { expect } from "chai";
import {
  deployContracts,
  loanFactory,
  usdcMock,
  btcMock,
  owner,
  lender,
  borrower,
} from "../utils/deployments";
import { createLoanAndGetId, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";

/**
 * MorphoAdapter Reference Pattern Tests
 *
 * Tests inspired by Morpho optimizer reference (~/repos/reference/morpho-optimizer/).
 * Covers branches and edge cases not in MorphoAdapterAdvanced.test.ts:
 *   - Constructor validation
 *   - configureMarket edge cases (bad params, active positions, MAX_NB_OF_MARKETS)
 *   - Deposit edge cases (zero amount, unconfigured market)
 *   - Withdraw edge cases (no position, zero recipient)
 *   - Emergency withdraw edge cases
 *   - totalActivePositions cross-token tracking
 *   - New batch view functions (getAllMarketsInfo, getPositionInfo, getBatchPositionInfo)
 *   - Ownable2Step ownership transfer
 */
describe("MorphoAdapter Reference Patterns", function () {
  let mockMorpho: any;
  let directAdapter: any;
  let directLoanFactory: any;
  let usdcAddress: string;
  let btcAddress: string;

  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: DUMMY_ADDR,
    oracle: DUMMY_ADDR,
    irm: DUMMY_ADDR,
    lltv: 1n,
  });

  beforeEach(async function () {
    await deployContracts();

    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    const signers = await hre.ethers.getSigners();
    directLoanFactory = signers[5];
    directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      directLoanFactory.address,
    ]);
    await directAdapter.waitForDeployment();
    await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
    await directAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

    // Fund
    await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await btcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("5", 8));
    await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    await btcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);

    // Fund MockMorpho for yield simulation
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10", 8));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Constructor Validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Constructor Validation", function () {
    it("Should revert with zero Morpho address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [ZERO_ADDR, directLoanFactory.address])
      ).to.be.revertedWith("Morpho address cannot be zero");
    });

    it("Should revert with zero LoanFactory address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [await mockMorpho.getAddress(), ZERO_ADDR])
      ).to.be.revertedWith("LoanFactory address cannot be zero");
    });

    it("Should set immutable state correctly", async function () {
      expect(await directAdapter.morpho()).to.equal(await mockMorpho.getAddress());
      expect(await directAdapter.loanFactory()).to.equal(directLoanFactory.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // configureMarket Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("configureMarket Edge Cases", function () {
    it("Should revert with zero token address", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(ZERO_ADDR, makeMarketParams(ZERO_ADDR))
      ).to.be.revertedWith("Token cannot be zero");
    });

    it("Should revert with zero loanToken in params", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: ZERO_ADDR,
          collateralToken: DUMMY_ADDR,
          oracle: DUMMY_ADDR,
          irm: DUMMY_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("Loan token cannot be zero");
    });

    it("Should revert with zero collateralToken", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: DUMMY_ADDR,
          collateralToken: ZERO_ADDR,
          oracle: DUMMY_ADDR,
          irm: DUMMY_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("Collateral token cannot be zero");
    });

    it("Should revert with zero oracle", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: DUMMY_ADDR,
          collateralToken: DUMMY_ADDR,
          oracle: ZERO_ADDR,
          irm: DUMMY_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("Oracle cannot be zero");
    });

    it("Should revert with zero irm", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: DUMMY_ADDR,
          collateralToken: DUMMY_ADDR,
          oracle: DUMMY_ADDR,
          irm: ZERO_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("IRM cannot be zero");
    });

    it("Should revert with zero lltv", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: DUMMY_ADDR,
          collateralToken: DUMMY_ADDR,
          oracle: DUMMY_ADDR,
          irm: DUMMY_ADDR,
          lltv: 0n,
        })
      ).to.be.revertedWith("LLTV must be > 0");
    });

    it("Should revert when token != params.loanToken", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(DUMMY_ADDR, {
          loanToken: "0x0000000000000000000000000000000000000002",
          collateralToken: DUMMY_ADDR,
          oracle: DUMMY_ADDR,
          irm: DUMMY_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("Token must match market loanToken");
    });

    it("Should revert when active positions exist for token", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress))
      ).to.be.revertedWith("Active positions exist for token");
    });

    it("Should allow reconfiguration after all positions withdrawn", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      // Should succeed now
      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.true;
    });

    it("Should emit MarketConfigured event", async function () {
      const newToken = "0x0000000000000000000000000000000000000042";
      const params = makeMarketParams(newToken);
      await expect(
        directAdapter.connect(owner).configureMarket(newToken, params)
      ).to.emit(directAdapter, "MarketConfigured");
    });

    it("Should reject configureMarket from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).configureMarket(DUMMY_ADDR, makeMarketParams(DUMMY_ADDR))
      ).to.be.reverted;
    });

    it("Should enforce MAX_NB_OF_MARKETS limit", async function () {
      // Deploy fresh adapter so we can fill it
      const freshAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await freshAdapter.waitForDeployment();

      // Fill up to MAX_NB_OF_MARKETS (128)
      const maxMarkets = await freshAdapter.MAX_NB_OF_MARKETS();
      for (let i = 1; i <= Number(maxMarkets); i++) {
        const addr = "0x" + i.toString(16).padStart(40, "0");
        await freshAdapter.connect(owner).configureMarket(addr, makeMarketParams(addr));
      }

      expect(await freshAdapter.getMarketCount()).to.equal(maxMarkets);

      // 129th should revert
      const overflowAddr = "0x" + (Number(maxMarkets) + 1).toString(16).padStart(40, "0");
      await expect(
        freshAdapter.connect(owner).configureMarket(overflowAddr, makeMarketParams(overflowAddr))
      ).to.be.revertedWith("Max markets reached");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Deposit Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Deposit Edge Cases", function () {
    it("Should revert with zero amount", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 0n, 100n)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert for unconfigured market", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.connect(directLoanFactory).deposit(randomToken, 1000n, 100n)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should revert from non-LoanFactory caller", async function () {
      await expect(
        directAdapter.connect(owner).deposit(usdcAddress, 1000n, 100n)
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should emit Deposited event with correct args", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n)
      ).to.emit(directAdapter, "Deposited")
        .withArgs(100n, usdcAddress, amount, amount); // MockMorpho returns 1:1 shares
    });

    it("Should accumulate shares on re-deposit to same loanId", async function () {
      const amount = hre.ethers.parseUnits("500", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.equal(amount * 2n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount * 2n);
      // activePositions should be 1, not 2
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
      expect(await directAdapter.totalActivePositions()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Withdraw Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Withdraw Edge Cases", function () {
    it("Should revert with zero recipient", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, ZERO_ADDR)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should revert when no position exists", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 999n, directLoanFactory.address)
      ).to.be.revertedWith("No position for loan");
    });

    it("Should revert from non-LoanFactory caller", async function () {
      await expect(
        directAdapter.connect(owner).withdraw(usdcAddress, 100n, owner.address)
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should emit Withdrawn event with correct args", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const expectedAssets = amount + amount / 100n; // 1% yield
      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address)
      ).to.emit(directAdapter, "Withdrawn")
        .withArgs(100n, usdcAddress, expectedAssets, amount, directLoanFactory.address);
    });

    it("Should return correct assets amount including yield", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const balBefore = await usdcMock.balanceOf(directLoanFactory.address);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      const balAfter = await usdcMock.balanceOf(directLoanFactory.address);

      // MockMorpho gives 1% yield
      const yield_ = amount / 100n;
      expect(balAfter - balBefore).to.equal(amount + yield_);
    });

    it("Should clear all position state on withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.equal(0n);
      expect(await directAdapter.depositedAmount(100n, usdcAddress)).to.equal(0n);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
      expect(await directAdapter.totalActivePositions()).to.equal(0);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Emergency Withdraw Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Emergency Withdraw Edge Cases", function () {
    it("Should revert with zero recipient", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, ZERO_ADDR)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should revert when no position exists", async function () {
      await expect(
        directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 999n, owner.address)
      ).to.be.revertedWith("No position for loan");
    });

    it("Should revert from non-owner caller", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).emergencyWithdraw(usdcAddress, 100n, owner.address)
      ).to.be.reverted;
    });

    it("Should emit EmergencyWithdrawn event", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const expectedAssets = amount + amount / 100n;
      await expect(
        directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address)
      ).to.emit(directAdapter, "EmergencyWithdrawn")
        .withArgs(100n, usdcAddress, expectedAssets, amount, owner.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // totalActivePositions Cross-Token Tracking
  // ═══════════════════════════════════════════════════════════════════════════

  describe("totalActivePositions Cross-Token", function () {
    it("Should track positions across multiple tokens", async function () {
      const usdcAmount = hre.ethers.parseUnits("1000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      expect(await directAdapter.totalActivePositions()).to.equal(0);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 100n);
      expect(await directAdapter.totalActivePositions()).to.equal(1);

      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 200n);
      expect(await directAdapter.totalActivePositions()).to.equal(2);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 300n);
      expect(await directAdapter.totalActivePositions()).to.equal(3);

      // Withdraw one
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      expect(await directAdapter.totalActivePositions()).to.equal(2);

      // Emergency withdraw another
      await directAdapter.connect(owner).emergencyWithdraw(btcAddress, 200n, owner.address);
      expect(await directAdapter.totalActivePositions()).to.equal(1);

      // Withdraw last
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 300n, directLoanFactory.address);
      expect(await directAdapter.totalActivePositions()).to.equal(0);
    });

    it("Should not double-count re-deposits to same loanId", async function () {
      const amount = hre.ethers.parseUnits("500", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.totalActivePositions()).to.equal(1);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // View Functions (Morpho optimizer lens pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("getMarketParams", function () {
    it("Should return params for configured market", async function () {
      const params = await directAdapter.getMarketParams(usdcAddress);
      expect(params.loanToken).to.equal(usdcAddress);
      expect(params.collateralToken).to.equal(DUMMY_ADDR);
      expect(params.oracle).to.equal(DUMMY_ADDR);
      expect(params.irm).to.equal(DUMMY_ADDR);
      expect(params.lltv).to.equal(1n);
    });

    it("Should revert for unconfigured token", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.getMarketParams(randomToken)
      ).to.be.revertedWith("No Morpho market for token");
    });
  });

  describe("getShares", function () {
    it("Should return shares for active position", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.getShares(100n, usdcAddress)).to.equal(amount);
    });

    it("Should return zero for non-existent position", async function () {
      expect(await directAdapter.getShares(999n, usdcAddress)).to.equal(0n);
    });
  });

  describe("hasMarket", function () {
    it("Should return true for configured token", async function () {
      expect(await directAdapter.hasMarket(usdcAddress)).to.be.true;
    });

    it("Should return false for unconfigured token", async function () {
      expect(await directAdapter.hasMarket("0x0000000000000000000000000000000000000099")).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // New Batch View Functions (from Morpho optimizer lens patterns)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("getPositionInfo (batch view)", function () {
    it("Should return correct info for active position", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const info = await directAdapter.getPositionInfo(100n, usdcAddress);
      expect(info.shares).to.equal(amount);
      expect(info.deposited).to.equal(amount);
      expect(info.isActive).to.be.true;
    });

    it("Should return zeros for non-existent position", async function () {
      const info = await directAdapter.getPositionInfo(999n, usdcAddress);
      expect(info.shares).to.equal(0n);
      expect(info.deposited).to.equal(0n);
      expect(info.isActive).to.be.false;
    });

    it("Should reflect accumulated deposits", async function () {
      const amount = hre.ethers.parseUnits("500", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const info = await directAdapter.getPositionInfo(100n, usdcAddress);
      expect(info.shares).to.equal(amount * 2n);
      expect(info.deposited).to.equal(amount * 2n);
      expect(info.isActive).to.be.true;
    });

    it("Should show inactive after withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      const info = await directAdapter.getPositionInfo(100n, usdcAddress);
      expect(info.shares).to.equal(0n);
      expect(info.deposited).to.equal(0n);
      expect(info.isActive).to.be.false;
    });
  });

  describe("getAllMarketsInfo (batch view)", function () {
    it("Should return info for all configured markets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(owner).setMarketPaused(btcAddress, true);

      const info = await directAdapter.getAllMarketsInfo();
      expect(info.tokens.length).to.equal(2);

      // Find USDC index
      const usdcIdx = info.tokens.indexOf(usdcAddress);
      expect(usdcIdx).to.be.gte(0);
      expect(info._totalShares[usdcIdx]).to.equal(amount);
      expect(info._activePositions[usdcIdx]).to.equal(1n);
      expect(info.pausedFlags[usdcIdx]).to.be.false;
      expect(info.frozenFlags[usdcIdx]).to.be.false;

      // Find BTC index
      const btcIdx = info.tokens.indexOf(btcAddress);
      expect(btcIdx).to.be.gte(0);
      expect(info._totalShares[btcIdx]).to.equal(0n);
      expect(info.pausedFlags[btcIdx]).to.be.true;
    });

    it("Should return empty arrays when no markets configured", async function () {
      const freshAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await freshAdapter.waitForDeployment();

      const info = await freshAdapter.getAllMarketsInfo();
      expect(info.tokens.length).to.equal(0);
      expect(info._totalShares.length).to.equal(0);
    });

    it("Should include caps in batch info", async function () {
      const cap = hre.ethers.parseUnits("5000", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      const info = await directAdapter.getAllMarketsInfo();
      const usdcIdx = info.tokens.indexOf(usdcAddress);
      expect(info.caps[usdcIdx]).to.equal(cap);
    });

    it("Should reflect freeze status", async function () {
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

      const info = await directAdapter.getAllMarketsInfo();
      const usdcIdx = info.tokens.indexOf(usdcAddress);
      expect(info.frozenFlags[usdcIdx]).to.be.true;
    });
  });

  describe("getBatchPositionInfo (batch view)", function () {
    it("Should return info for multiple positions", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 200n);

      const info = await directAdapter.getBatchPositionInfo(usdcAddress, [100n, 200n, 999n]);
      expect(info.shares[0]).to.equal(amount1);
      expect(info.shares[1]).to.equal(amount2);
      expect(info.shares[2]).to.equal(0n); // non-existent

      expect(info.deposited[0]).to.equal(amount1);
      expect(info.deposited[1]).to.equal(amount2);
      expect(info.deposited[2]).to.equal(0n);
    });

    it("Should return empty arrays for empty input", async function () {
      const info = await directAdapter.getBatchPositionInfo(usdcAddress, []);
      expect(info.shares.length).to.equal(0);
      expect(info.deposited.length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Ownable2Step Ownership Transfer
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Ownable2Step", function () {
    it("Should have correct initial owner", async function () {
      expect(await directAdapter.owner()).to.equal(owner.address);
    });

    it("Should support two-step ownership transfer", async function () {
      const signers = await hre.ethers.getSigners();
      const newOwner = signers[6];

      await directAdapter.connect(owner).transferOwnership(newOwner.address);
      // Pending owner set but not yet effective
      expect(await directAdapter.owner()).to.equal(owner.address);
      expect(await directAdapter.pendingOwner()).to.equal(newOwner.address);

      // New owner accepts
      await directAdapter.connect(newOwner).acceptOwnership();
      expect(await directAdapter.owner()).to.equal(newOwner.address);
    });

    it("Should reject transferOwnership from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).transferOwnership(directLoanFactory.address)
      ).to.be.reverted;
    });

    it("Should allow new owner to admin functions after transfer", async function () {
      const signers = await hre.ethers.getSigners();
      const newOwner = signers[6];

      await directAdapter.connect(owner).transferOwnership(newOwner.address);
      await directAdapter.connect(newOwner).acceptOwnership();

      // New owner can pause
      await directAdapter.connect(newOwner).setMarketPaused(usdcAddress, true);
      expect(await directAdapter.isMarketPaused(usdcAddress)).to.be.true;

      // Old owner cannot
      await expect(
        directAdapter.connect(owner).setMarketPaused(usdcAddress, false)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Frozen Market Withdraw Blocking (verify both normal + LoanFactory paths)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Frozen Market — Deposit Blocking", function () {
    it("Should check frozen before paused on deposit", async function () {
      // Frozen check comes before paused check in deposit()
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 1000n, 100n)
      ).to.be.revertedWith("Market frozen");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Batch Emergency Withdraw — Additional Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Batch Emergency Withdraw — totalActivePositions", function () {
    it("Should correctly decrement totalActivePositions in batch", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);
      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 300n);

      expect(await directAdapter.totalActivePositions()).to.equal(3);

      // Batch withdraw USDC positions
      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [100n, 200n], owner.address);
      expect(await directAdapter.totalActivePositions()).to.equal(1); // Only BTC position left
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
      expect(await directAdapter.activePositions(btcAddress)).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Yield Distribution Verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Yield Distribution", function () {
    it("Should distribute yield proportionally to position size", async function () {
      const small = hre.ethers.parseUnits("100", 6);
      const large = hre.ethers.parseUnits("10000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, small, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, large, 200n);

      const balBefore = await usdcMock.balanceOf(directLoanFactory.address);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      const balMid = await usdcMock.balanceOf(directLoanFactory.address);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 200n, directLoanFactory.address);
      const balAfter = await usdcMock.balanceOf(directLoanFactory.address);

      const smallYield = balMid - balBefore - small;
      const largeYield = balAfter - balMid - large;

      // Large position should earn ~100x more yield than small
      expect(largeYield).to.be.gt(smallYield * 90n); // Allow some rounding
    });

    it("Should send yield to specified recipient, not depositor", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const signers = await hre.ethers.getSigners();
      const recipient = signers[7];

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const balBefore = await usdcMock.balanceOf(recipient.address);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, recipient.address);
      const balAfter = await usdcMock.balanceOf(recipient.address);

      // Recipient got principal + yield
      expect(balAfter - balBefore).to.equal(amount + amount / 100n);
    });
  });
});
