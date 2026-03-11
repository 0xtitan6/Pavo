/**
 * Integration.test.ts
 *
 * Integration tests for: LoanFactory → MorphoAdapter → MockMorpho
 *
 * Covers the full lifecycle:
 *   createLoan → idle funds deposited into Morpho via adapter
 *   cancelLoan → funds + yield returned from Morpho
 *   takeUpLoan → funds withdrawn from Morpho, surplus distributed
 *
 * Also covers: MorphoAdapter pause/cap/batch features, error paths
 */
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

describe("MorphoAdapter Integration (LoanFactory → MorphoAdapter → MockMorpho)", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;
  let btcAddress: string;
  let loanFactoryAddress: string;

  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: DUMMY_ADDR,
    oracle: DUMMY_ADDR,
    irm: DUMMY_ADDR,
    lltv: 1n,
  });

  const LEND_ASSET = hre.ethers.parseUnits("10000", 6);
  const BORROW_COLLATERAL = hre.ethers.parseUnits("1", 8);
  const RATE_INDEX = 0;
  const DURATION_INDEX = 2;
  const INITIAL_RATIO = 15000;
  const LIQ_THRESHOLD = 11000;

  async function createLendOffer(signer: any): Promise<bigint> {
    const params = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [loanId] = await createLoanAndGetId(signer, params);
    return loanId;
  }

  async function createBorrowOffer(signer: any): Promise<bigint> {
    const params = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [loanId] = await createLoanAndGetId(signer, params);
    return loanId;
  }

  beforeEach(async function () {
    await deployContracts();

    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
    loanFactoryAddress = await loanFactory.getAddress();

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      loanFactoryAddress,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
    await morphoAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

    await loanFactory.connect(owner).setMorphoAdapter(await morphoAdapter.getAddress());

    // Fund MockMorpho with reserves for 1% yield payouts
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10", 8));

    // Fund lender and borrower
    await usdcMock.connect(owner).transfer(lender.address, hre.ethers.parseUnits("50000", 6));
    await btcMock.connect(owner).transfer(borrower.address, hre.ethers.parseUnits("10", 8));

    await usdcMock.connect(lender).approve(loanFactoryAddress, hre.ethers.MaxUint256);
    await btcMock.connect(borrower).approve(loanFactoryAddress, hre.ethers.MaxUint256);
  });

  // ── Full lifecycle: create → cancel with Morpho ──────────────────────────

  describe("createLoan → cancelLoan (lend offer via Morpho)", function () {
    it("Should route lend funds through Morpho adapter and return with yield on cancel", async function () {
      const loanId = await createLendOffer(lender);

      // Adapter holds shares
      const shares = await morphoAdapter.sharesOf(loanId, usdcAddress);
      expect(shares).to.equal(LEND_ASSET);

      // LoanFactory holds nothing — all in Morpho
      expect(await usdcMock.balanceOf(loanFactoryAddress)).to.equal(0n);

      // Cancel — funds return with 1% yield
      const lenderBefore = await usdcMock.balanceOf(lender.address);
      await loanFactory.connect(lender).cancelLoan(loanId);
      const lenderAfter = await usdcMock.balanceOf(lender.address);

      const received = lenderAfter - lenderBefore;
      const expectedYield = LEND_ASSET / 100n;
      expect(received).to.equal(LEND_ASSET + expectedYield);

      // Shares cleared
      expect(await morphoAdapter.sharesOf(loanId, usdcAddress)).to.equal(0n);
    });

    it("Should route borrow collateral through Morpho and return with yield on cancel", async function () {
      const loanId = await createBorrowOffer(borrower);

      const shares = await morphoAdapter.sharesOf(loanId, btcAddress);
      expect(shares).to.equal(BORROW_COLLATERAL);
      expect(await btcMock.balanceOf(loanFactoryAddress)).to.equal(0n);

      const borrowerBefore = await btcMock.balanceOf(borrower.address);
      await loanFactory.connect(borrower).cancelLoan(loanId);
      const borrowerAfter = await btcMock.balanceOf(borrower.address);

      const received = borrowerAfter - borrowerBefore;
      const expectedYield = BORROW_COLLATERAL / 100n;
      expect(received).to.equal(BORROW_COLLATERAL + expectedYield);
    });
  });

  // ── Full lifecycle: create → takeUpLoan ──────────────────────────────────

  describe("createLoan → takeUpLoan (borrower takes lend offer via Morpho)", function () {
    it("Should withdraw from Morpho on match, yield surplus to lender", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      const lenderBefore = await usdcMock.balanceOf(lender.address);
      const borrowerBefore = await usdcMock.balanceOf(borrower.address);

      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // Borrower receives principal
      const borrowerAfter = await usdcMock.balanceOf(borrower.address);
      expect(borrowerAfter - borrowerBefore).to.equal(LEND_ASSET);

      // Lender receives yield surplus (1%)
      const lenderAfter = await usdcMock.balanceOf(lender.address);
      expect(lenderAfter - lenderBefore).to.equal(LEND_ASSET / 100n);

      // Both adapter positions cleared
      expect(await morphoAdapter.sharesOf(lendId, usdcAddress)).to.equal(0n);
      expect(await morphoAdapter.sharesOf(borrowId, btcAddress)).to.equal(0n);
    });

    it("Should handle collateral yield surplus — borrower gets collateral surplus", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);

      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // Borrower receives collateral yield surplus (1% of 1 BTC)
      const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);
      const collateralYield = BORROW_COLLATERAL / 100n;
      expect(borrowerBtcAfter - borrowerBtcBefore).to.equal(collateralYield);
    });
  });

  describe("createLoan → takeUpLoan (lender takes borrow offer via Morpho)", function () {
    it("Should withdraw from Morpho on match, yield surplus to lender", async function () {
      const lendId = await createLendOffer(lender);
      const borrowId = await createBorrowOffer(borrower);

      const lenderBefore = await usdcMock.balanceOf(lender.address);
      const borrowerBefore = await usdcMock.balanceOf(borrower.address);

      // Lender takes borrow offer
      await loanFactory.connect(lender).takeUpLoan(lendId, borrowId);

      const borrowerAfter = await usdcMock.balanceOf(borrower.address);
      expect(borrowerAfter - borrowerBefore).to.equal(LEND_ASSET);

      const lenderAfter = await usdcMock.balanceOf(lender.address);
      expect(lenderAfter - lenderBefore).to.equal(LEND_ASSET / 100n);
    });
  });

  // ── Negative yield via MockYieldAdapter ──────────────────────────────────

  describe("Negative yield handling via MockYieldAdapter", function () {
    let negAdapter: any;

    beforeEach(async function () {
      negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
      await negAdapter.waitForDeployment();

      // Two-step swap
      await loanFactory.connect(owner).setYieldAdapter(hre.ethers.ZeroAddress);
      await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());

      await negAdapter.setSupported(usdcAddress, true);
      await negAdapter.setSupported(btcAddress, true);
      await negAdapter.setYieldBps(9500); // -5% yield

      // Fund adapter (use smaller amounts that fit within owner's balance)
      await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
      await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));
    });

    it("Should handle negative lend yield — borrower receives reduced principal", async function () {
      const lendId = await createLendOffer(lender);
      const borrowId = await createBorrowOffer(borrower);

      const borrowerBefore = await usdcMock.balanceOf(borrower.address);

      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      const borrowerAfter = await usdcMock.balanceOf(borrower.address);
      const expectedReduced = (LEND_ASSET * 9500n) / 10000n;
      expect(borrowerAfter - borrowerBefore).to.equal(expectedReduced);
    });

    it("Should handle negative collateral yield — collateral reduced, loan records actual amount", async function () {
      const lendId = await createLendOffer(lender);
      const borrowId = await createBorrowOffer(borrower);

      // Match: lender takes borrow offer
      await loanFactory.connect(lender).takeUpLoan(lendId, borrowId);

      // The loan's collateral should reflect the reduced amount after negative yield
      const loan = await loanFactory.loans(borrowId);
      const expectedCollateral = (BORROW_COLLATERAL * 9500n) / 10000n;
      expect(loan.collateral).to.equal(expectedCollateral);
    });
  });

  // ── Market pause ─────────────────────────────────────────────────────────

  describe("MorphoAdapter market pause", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    });

    it("Should reject deposits when market is paused", async function () {
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n)
      ).to.be.revertedWith("Market deposits paused");
    });

    it("Should allow deposits after unpausing", async function () {
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, false);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
      expect(await directAdapter.sharesOf(1n, usdcAddress)).to.be.gt(0n);
    });

    it("Should allow withdrawals even when market is paused", async function () {
      // Deposit first
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);

      // Pause
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      // Fund MockMorpho for yield payout
      await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("1000", 6));

      // Withdraw should still work
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 1n, directLoanFactory.address);
      expect(await directAdapter.sharesOf(1n, usdcAddress)).to.equal(0n);
    });

    it("Should emit MarketPauseToggled event", async function () {
      await expect(directAdapter.connect(owner).setMarketPaused(usdcAddress, true))
        .to.emit(directAdapter, "MarketPauseToggled")
        .withArgs(usdcAddress, true);
    });

    it("Should reject setMarketPaused for unconfigured token", async function () {
      await expect(
        directAdapter.connect(owner).setMarketPaused(btcAddress, true)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should reject setMarketPaused from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setMarketPaused(usdcAddress, true)
      ).to.be.reverted;
    });

    it("isMarketPaused should return correct state", async function () {
      expect(await directAdapter.isMarketPaused(usdcAddress)).to.be.false;
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      expect(await directAdapter.isMarketPaused(usdcAddress)).to.be.true;
    });
  });

  // ── Market cap ───────────────────────────────────────────────────────────

  describe("MorphoAdapter market cap", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    });

    it("Should enforce deposit cap", async function () {
      const cap = hre.ethers.parseUnits("500", 6); // 500 USDC cap
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      // Deposit within cap should succeed
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("400", 6), 1n);

      // Deposit exceeding cap should fail
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("200", 6), 2n)
      ).to.be.revertedWith("Market deposit cap exceeded");
    });

    it("Should allow unlimited deposits when cap is 0", async function () {
      await directAdapter.connect(owner).setMarketCap(usdcAddress, 0);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("10000", 6), 1n);
      expect(await directAdapter.sharesOf(1n, usdcAddress)).to.be.gt(0n);
    });

    it("Should emit MarketCapSet event", async function () {
      const cap = hre.ethers.parseUnits("1000", 6);
      await expect(directAdapter.connect(owner).setMarketCap(usdcAddress, cap))
        .to.emit(directAdapter, "MarketCapSet")
        .withArgs(usdcAddress, cap);
    });

    it("Should reject setMarketCap for unconfigured token", async function () {
      await expect(
        directAdapter.connect(owner).setMarketCap(btcAddress, 1000n)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should reject setMarketCap from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setMarketCap(usdcAddress, 1000n)
      ).to.be.reverted;
    });

    it("Should track totalShares correctly", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 1n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount1);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 2n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount1 + amount2);
    });
  });

  // ── Batch emergency withdraw ─────────────────────────────────────────────

  describe("MorphoAdapter batchEmergencyWithdraw", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);

      // Fund MockMorpho for yield payouts
      await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    });

    it("Should batch withdraw multiple positions", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 2n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 3n);

      expect(await directAdapter.totalActivePositions()).to.equal(3);

      const ownerBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n, 2n, 3n], owner.address);
      const ownerAfter = await usdcMock.balanceOf(owner.address);

      // Should receive 3 * (1000 + 1% yield) = 3030 USDC
      const expectedTotal = 3n * (amount + amount / 100n);
      expect(ownerAfter - ownerBefore).to.equal(expectedTotal);

      // All positions cleared
      expect(await directAdapter.totalActivePositions()).to.equal(0);
      expect(await directAdapter.sharesOf(1n, usdcAddress)).to.equal(0n);
      expect(await directAdapter.sharesOf(2n, usdcAddress)).to.equal(0n);
      expect(await directAdapter.sharesOf(3n, usdcAddress)).to.equal(0n);
    });

    it("Should skip empty positions in batch", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      // loanId 2 has no deposit — should be skipped

      const ownerBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n, 2n], owner.address);
      const ownerAfter = await usdcMock.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(amount + amount / 100n);
    });

    it("Should reject empty loanIds array", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [], owner.address)
      ).to.be.revertedWith("Empty loanIds array");
    });

    it("Should reject batch where all positions are empty", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [99n, 100n], owner.address)
      ).to.be.revertedWith("No assets withdrawn");
    });

    it("Should reject batchEmergencyWithdraw with zero recipient", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n], hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject batchEmergencyWithdraw from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).batchEmergencyWithdraw(usdcAddress, [1n], owner.address)
      ).to.be.reverted;
    });

    it("Should emit EmergencyWithdrawn event for each position", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 2n);

      const tx = await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n, 2n], owner.address);
      const receipt = await tx.wait();

      const emergencyEvents = receipt.logs.filter(
        (log: any) => {
          try {
            return directAdapter.interface.parseLog(log)?.name === "EmergencyWithdrawn";
          } catch { return false; }
        }
      );
      expect(emergencyEvents.length).to.equal(2);
    });
  });

  // ── getMarketInfo view ───────────────────────────────────────────────────

  describe("MorphoAdapter getMarketInfo", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    });

    it("Should return correct market info", async function () {
      const cap = hre.ethers.parseUnits("100000", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      const amount = hre.ethers.parseUnits("1000", 6);
      // Unpause to deposit
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, false);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      // Re-pause
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._totalShares).to.equal(amount);
      expect(info._cap).to.equal(cap);
      expect(info._activePositions).to.equal(1);
      expect(info._paused).to.be.true;
    });

    it("Should return zeros for unconfigured token", async function () {
      const info = await directAdapter.getMarketInfo(btcAddress);
      expect(info._totalShares).to.equal(0);
      expect(info._cap).to.equal(0);
      expect(info._activePositions).to.equal(0);
      expect(info._paused).to.be.false;
    });
  });

  // ── Deposit accumulation (same loanId, multiple deposits) ────────────────

  describe("Share accumulation for same loanId", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    });

    it("Should accumulate shares for same loanId without double-counting activePositions", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
      expect(await directAdapter.totalActivePositions()).to.equal(1);

      // Second deposit for same loanId
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      // activePositions should NOT increment again
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
      expect(await directAdapter.totalActivePositions()).to.equal(1);

      // But shares should accumulate
      expect(await directAdapter.sharesOf(1n, usdcAddress)).to.equal(amount * 2n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount * 2n);
    });
  });

  // ── EmergencyWithdrawn event on single emergencyWithdraw ─────────────────

  describe("emergencyWithdraw event", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
      await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    });

    it("Should emit EmergencyWithdrawn event", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);

      await expect(
        directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, owner.address)
      ).to.emit(directAdapter, "EmergencyWithdrawn");
    });
  });

  // ── Full loan lifecycle: create → takeUp → endLoan ─────────────────────
  describe("Full lifecycle: create → takeUp → endLoan (with Morpho adapter)", function () {
    it("Should complete full loan lifecycle including endLoan after maturity", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      // Match the offers
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // The active loan is stored under lendId (borrower-takes-lend path)
      const loan = await loanFactory.loans(lendId);
      expect(loan.s).to.equal(2n); // Status.s3 = active (0-indexed enum: s1=0, s2=1, s3=2)

      // Advance time past maturity (duration index 2 = 30 days)
      await hre.ethers.provider.send("evm_increaseTime", [30 * 86400 + 1]);
      await hre.ethers.provider.send("evm_mine", []);

      // End the loan — collateral split between lender (repayment) and borrower (excess)
      const lenderBtcBefore = await btcMock.balanceOf(lender.address);
      const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);

      await loanFactory.connect(lender).endLoan(lendId);

      const lenderBtcAfter = await btcMock.balanceOf(lender.address);
      const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);

      // Lender receives collateral payout, borrower receives excess
      expect(lenderBtcAfter).to.be.gt(lenderBtcBefore);
      // Borrower may or may not receive excess depending on collateral value vs repayment
      // With 1 BTC at $50k and 10k USDC loan, there should be significant excess
      expect(borrowerBtcAfter).to.be.gt(borrowerBtcBefore);

      // Loan should be deleted
      const deletedLoan = await loanFactory.loans(lendId);
      expect(deletedLoan.id).to.equal(0n);
    });
  });

  // ── Full loan lifecycle: create → takeUp → interruptLoan ───────────────
  describe("Full lifecycle: create → takeUp → interruptLoan (early repayment)", function () {
    it("Should allow borrower to repay early and get full collateral back", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      // Match
      await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

      // Advance time partway (10 days into 30-day loan)
      await hre.ethers.provider.send("evm_increaseTime", [10 * 86400]);
      await hre.ethers.provider.send("evm_mine", []);

      // Borrower needs USDC for full repayment (principal + full-term interest)
      // Give borrower extra USDC for repayment
      await usdcMock.connect(owner).transfer(borrower.address, hre.ethers.parseUnits("20000", 6));
      await usdcMock.connect(borrower).approve(await loanFactory.getAddress(), hre.ethers.MaxUint256);

      const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);
      const lenderUsdcBefore = await usdcMock.balanceOf(lender.address);

      // Borrower interrupts (early repayment)
      await loanFactory.connect(borrower).interruptLoan(lendId);

      // Borrower gets full collateral back
      const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);
      expect(borrowerBtcAfter).to.be.gt(borrowerBtcBefore);

      // Lender receives repayment (principal + interest)
      const lenderUsdcAfter = await usdcMock.balanceOf(lender.address);
      expect(lenderUsdcAfter).to.be.gt(lenderUsdcBefore);

      // Loan deleted
      const deletedLoan = await loanFactory.loans(lendId);
      expect(deletedLoan.id).to.equal(0n);
    });
  });

  // ── Adapter deposit with zero amount ───────────────────────────────────
  describe("MorphoAdapter zero-amount edge cases", function () {
    let directAdapter: any;
    let directLoanFactory: any;

    beforeEach(async function () {
      const signers = await hre.ethers.getSigners();
      directLoanFactory = signers[5];

      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await directAdapter.waitForDeployment();

      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
      await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    });

    it("Should reject deposit with zero amount", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 0n, 1n)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should reject withdraw with zero recipient", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);

      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 1n, hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject withdraw when no position exists", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 999n, directLoanFactory.address)
      ).to.be.revertedWith("No position for loan");
    });

    it("Should reject deposit for unconfigured token", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).deposit(btcAddress, 1000n, 1n)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should reject deposit from non-LoanFactory", async function () {
      await expect(
        directAdapter.connect(owner).deposit(usdcAddress, 1000n, 1n)
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should reject withdraw from non-LoanFactory", async function () {
      await expect(
        directAdapter.connect(owner).withdraw(usdcAddress, 1n, owner.address)
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should reject partial withdraw with zero shares", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(usdcAddress, 1n, 0n, directLoanFactory.address)
      ).to.be.revertedWith("Shares must be > 0");
    });

    it("Should reject partial withdraw of full shares (use withdraw instead)", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 1n);
      const shares = await directAdapter.sharesOf(1n, usdcAddress);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(usdcAddress, 1n, shares, directLoanFactory.address)
      ).to.be.revertedWith("Use withdraw for full redemption");
    });
  });

  // ── YieldSurplus event verification ────────────────────────────────────
  describe("YieldSurplus event emission on takeUpLoan", function () {
    it("Should emit YieldSurplus event when lend yield surplus distributed", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      const expectedSurplus = LEND_ASSET / 100n; // 1% yield

      await expect(loanFactory.connect(borrower).takeUpLoan(borrowId, lendId))
        .to.emit(loanFactory, "YieldSurplus")
        .withArgs(lendId, lender.address, usdcAddress, expectedSurplus);
    });

    it("Should emit YieldSurplus for collateral surplus to borrower", async function () {
      const borrowId = await createBorrowOffer(borrower);
      const lendId = await createLendOffer(lender);

      const expectedCollateralSurplus = BORROW_COLLATERAL / 100n; // 1% yield

      await expect(loanFactory.connect(borrower).takeUpLoan(borrowId, lendId))
        .to.emit(loanFactory, "YieldSurplus")
        .withArgs(borrowId, borrower.address, btcAddress, expectedCollateralSurplus);
    });
  });

  // ── Constructor validation ─────────────────────────────────────────────
  describe("MorphoAdapter constructor validation", function () {
    it("Should reject zero Morpho address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [hre.ethers.ZeroAddress, owner.address])
      ).to.be.revertedWith("Morpho address cannot be zero");
    });

    it("Should reject zero LoanFactory address", async function () {
      await expect(
        hre.ethers.deployContract("MorphoAdapter", [await mockMorpho.getAddress(), hre.ethers.ZeroAddress])
      ).to.be.revertedWith("LoanFactory address cannot be zero");
    });
  });

  // ── configureMarket validation ─────────────────────────────────────────
  describe("MorphoAdapter configureMarket validation", function () {
    let directAdapter: any;

    beforeEach(async function () {
      directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        owner.address,
      ]);
      await directAdapter.waitForDeployment();
    });

    it("Should reject zero token address", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(hre.ethers.ZeroAddress, makeMarketParams(usdcAddress))
      ).to.be.revertedWith("Token cannot be zero");
    });

    it("Should reject token mismatch with market loanToken", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(usdcAddress))
      ).to.be.revertedWith("Token must match market loanToken");
    });

    it("Should reject configureMarket with zero loanToken in params", async function () {
      await expect(
        directAdapter.connect(owner).configureMarket(usdcAddress, {
          loanToken: hre.ethers.ZeroAddress,
          collateralToken: DUMMY_ADDR,
          oracle: DUMMY_ADDR,
          irm: DUMMY_ADDR,
          lltv: 1n,
        })
      ).to.be.revertedWith("Loan token cannot be zero");
    });
  });
});
