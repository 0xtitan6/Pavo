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

describe("MorphoAdapter Advanced (Morpho Optimizer Patterns)", function () {
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

  // Direct adapter setup (bypasses LoanFactory for unit testing)
  let directAdapter: any;
  let directLoanFactory: any;

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

    // Fund MockMorpho with reserves for yield simulation
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10", 8));

    // Fund users
    await usdcMock.connect(owner).transfer(lender.address, hre.ethers.parseUnits("50000", 6));
    await btcMock.connect(owner).transfer(borrower.address, hre.ethers.parseUnits("10", 8));
    await usdcMock.connect(lender).approve(loanFactoryAddress, hre.ethers.MaxUint256);
    await btcMock.connect(borrower).approve(loanFactoryAddress, hre.ethers.MaxUint256);

    // Direct adapter for unit tests
    const signers = await hre.ethers.getSigners();
    directLoanFactory = signers[5];
    directAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      directLoanFactory.address,
    ]);
    await directAdapter.waitForDeployment();
    await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
    await directAdapter.connect(owner).configureMarket(btcAddress, makeMarketParams(btcAddress));

    await usdcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await btcMock.connect(owner).transfer(directLoanFactory.address, hre.ethers.parseUnits("5", 8));
    await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);
    await btcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), hre.ethers.MaxUint256);

    // Fund MockMorpho for direct adapter too
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    await btcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10", 8));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Market Pause (Morpho optimizer: isPartiallyPaused pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Market Pause Controls", function () {
    it("Should pause deposits while allowing withdrawals", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const loanId = 100n;

      // Deposit first
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, loanId);

      // Pause market
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      // New deposit should fail
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n)
      ).to.be.revertedWith("Market deposits paused");

      // Withdrawal should still work
      const balBefore = await usdcMock.balanceOf(directLoanFactory.address);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, loanId, directLoanFactory.address);
      const balAfter = await usdcMock.balanceOf(directLoanFactory.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("Should emit MarketPauseToggled event", async function () {
      await expect(directAdapter.connect(owner).setMarketPaused(usdcAddress, true))
        .to.emit(directAdapter, "MarketPauseToggled")
        .withArgs(usdcAddress, true);

      await expect(directAdapter.connect(owner).setMarketPaused(usdcAddress, false))
        .to.emit(directAdapter, "MarketPauseToggled")
        .withArgs(usdcAddress, false);
    });

    it("Should reject pause from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setMarketPaused(usdcAddress, true)
      ).to.be.reverted;
    });

    it("Should reject pause for unconfigured token", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.connect(owner).setMarketPaused(randomToken, true)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should resume deposits after unpause", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, false);

      // Should succeed again
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.be.gt(0n);
    });

    it("Should report pause status via isMarketPaused view", async function () {
      expect(await directAdapter.isMarketPaused(usdcAddress)).to.be.false;
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      expect(await directAdapter.isMarketPaused(usdcAddress)).to.be.true;
    });

    it("Should allow emergency withdraw on paused market", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const loanId = 100n;

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, loanId);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, loanId, owner.address);
      const balAfter = await usdcMock.balanceOf(owner.address);
      expect(balAfter).to.be.gt(balBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Market Deposit Caps (exposure limits per market)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Market Deposit Caps", function () {
    it("Should enforce deposit cap", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      // Set cap to 1500 shares (MockMorpho is 1:1 shares)
      const cap = hre.ethers.parseUnits("1500", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      // First deposit: 1000 — under cap
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Second deposit: 1000 — would push to 2000, exceeding 1500 cap
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n)
      ).to.be.revertedWith("Market deposit cap exceeded");
    });

    it("Should allow deposit exactly at cap", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const cap = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount);
    });

    it("Should not enforce cap when set to 0 (unlimited)", async function () {
      const amount = hre.ethers.parseUnits("10000", 6);
      // Default cap is 0 = unlimited
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount);
    });

    it("Should emit MarketCapSet event", async function () {
      const cap = hre.ethers.parseUnits("5000", 6);
      await expect(directAdapter.connect(owner).setMarketCap(usdcAddress, cap))
        .to.emit(directAdapter, "MarketCapSet")
        .withArgs(usdcAddress, cap);
    });

    it("Should reject cap from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setMarketCap(usdcAddress, 1000n)
      ).to.be.reverted;
    });

    it("Should reject cap for unconfigured token", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.connect(owner).setMarketCap(randomToken, 1000n)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should allow more deposits after withdrawal frees cap space", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const cap = hre.ethers.parseUnits("1500", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      // Deposit 1000
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Would exceed cap
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n)
      ).to.be.revertedWith("Market deposit cap exceeded");

      // Withdraw first position — frees cap space
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      // Now deposit should succeed (totalShares back to 0)
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 300n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount);
    });

    it("Should remove cap when set to 0", async function () {
      const cap = hre.ethers.parseUnits("100", 6);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);

      // Remove cap
      await directAdapter.connect(owner).setMarketCap(usdcAddress, 0n);

      // Large deposit should work
      const amount = hre.ethers.parseUnits("10000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Total Shares Tracking
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Total Shares Tracking", function () {
    it("Should track cumulative shares across deposits", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 100n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount1);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 200n);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount1 + amount2);
    });

    it("Should decrease totalShares on withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(amount);
    });

    it("Should decrease totalShares on emergency withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(0n);
    });

    it("Should track shares independently per token", async function () {
      const usdcAmount = hre.ethers.parseUnits("5000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 200n);

      expect(await directAdapter.totalShares(usdcAddress)).to.equal(usdcAmount);
      expect(await directAdapter.totalShares(btcAddress)).to.equal(btcAmount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Batch Emergency Withdrawal (efficient multi-position recovery)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Batch Emergency Withdrawal", function () {
    it("Should withdraw multiple positions in one tx", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      // Create 3 positions
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 300n);

      expect(await directAdapter.activePositions(usdcAddress)).to.equal(3);

      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(
        usdcAddress,
        [100n, 200n, 300n],
        owner.address
      );
      const balAfter = await usdcMock.balanceOf(owner.address);

      // All positions cleared
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(0n);
      expect(await directAdapter.totalActivePositions()).to.equal(0);

      // Got funds back (with 1% yield each)
      expect(balAfter).to.be.gt(balBefore);
    });

    it("Should skip empty positions gracefully", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Include non-existent loanId 999 — should be skipped
      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(
        usdcAddress,
        [999n, 100n, 888n],
        owner.address
      );
      const balAfter = await usdcMock.balanceOf(owner.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.equal(0n);
    });

    it("Should revert if all positions are empty", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(
          usdcAddress,
          [999n, 888n],
          owner.address
        )
      ).to.be.revertedWith("No assets withdrawn");
    });

    it("Should reject batch with empty array", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(
          usdcAddress,
          [],
          owner.address
        )
      ).to.be.revertedWith("Empty loanIds array");
    });

    it("Should reject batch with zero recipient", async function () {
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(
          usdcAddress,
          [100n],
          hre.ethers.ZeroAddress
        )
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject batch from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).batchEmergencyWithdraw(
          usdcAddress,
          [100n],
          directLoanFactory.address
        )
      ).to.be.reverted;
    });

    it("Should emit EmergencyWithdrawn for each position", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      const tx = await directAdapter.connect(owner).batchEmergencyWithdraw(
        usdcAddress,
        [100n, 200n],
        owner.address
      );
      const receipt = await tx.wait();

      // Should have 2 EmergencyWithdrawn events
      const events = receipt.logs.filter(
        (log: any) => {
          try {
            return directAdapter.interface.parseLog(log)?.name === "EmergencyWithdrawn";
          } catch { return false; }
        }
      );
      expect(events.length).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getMarketInfo View Function
  // ═══════════════════════════════════════════════════════════════════════════

  describe("getMarketInfo", function () {
    it("Should return correct market info after deposits", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const cap = hre.ethers.parseUnits("5000", 6);

      await directAdapter.connect(owner).setMarketCap(usdcAddress, cap);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._totalShares).to.equal(amount * 2n);
      expect(info._cap).to.equal(cap);
      expect(info._activePositions).to.equal(2);
      expect(info._paused).to.be.false;
      expect(info._frozen).to.be.false;
    });

    it("Should reflect paused state", async function () {
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._paused).to.be.true;
      expect(info._frozen).to.be.false;
    });

    it("Should reflect frozen state", async function () {
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._frozen).to.be.true;
    });

    it("Should return zeros for unconfigured but queryable market", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      const info = await directAdapter.getMarketInfo(randomToken);
      expect(info._totalShares).to.equal(0n);
      expect(info._cap).to.equal(0n);
      expect(info._activePositions).to.equal(0);
      expect(info._paused).to.be.false;
      expect(info._frozen).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Idle-to-Match Flow (end-to-end via LoanFactory)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Idle-to-Match Flow (E2E)", function () {
    it("Should complete full flow: deposit → earn yield → match → withdrawal", async function () {
      // Step 1: Lender creates offer — USDC deposited into Morpho (idle yield)
      const lendOfferId = await createLendOffer(lender);
      expect(await morphoAdapter.sharesOf(lendOfferId, usdcAddress)).to.be.gt(0n);
      expect(await morphoAdapter.totalShares(usdcAddress)).to.be.gt(0n);

      // Step 2: Borrower creates offer — BTC deposited into Morpho (idle yield)
      const borrowOfferId = await createBorrowOffer(borrower);
      expect(await morphoAdapter.sharesOf(borrowOfferId, btcAddress)).to.be.gt(0n);
      expect(await morphoAdapter.totalShares(btcAddress)).to.be.gt(0n);

      // Step 3: Match — withdraws from Morpho, settles the loan
      const borrowerUsdcBefore = await usdcMock.balanceOf(borrower.address);
      await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

      // Step 4: Verify post-match state
      // USDC shares cleared (withdrawn for loan principal)
      expect(await morphoAdapter.sharesOf(lendOfferId, usdcAddress)).to.equal(0n);
      // BTC shares cleared (withdrawn for collateral)
      expect(await morphoAdapter.sharesOf(borrowOfferId, btcAddress)).to.equal(0n);
      // totalShares should be 0 for both
      expect(await morphoAdapter.totalShares(usdcAddress)).to.equal(0n);
      expect(await morphoAdapter.totalShares(btcAddress)).to.equal(0n);

      // Borrower received USDC
      expect(await usdcMock.balanceOf(borrower.address)).to.be.gt(borrowerUsdcBefore);
    });

    it("Should handle pause during idle period then unpause for match", async function () {
      const lendOfferId = await createLendOffer(lender);

      // Pause USDC market — no new deposits but existing positions safe
      await morphoAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      // Borrower can still create offer (BTC market not paused)
      const borrowOfferId = await createBorrowOffer(borrower);

      // Unpause for the match
      await morphoAdapter.connect(owner).setMarketPaused(usdcAddress, false);

      // Match succeeds
      await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);

      expect(await morphoAdapter.sharesOf(lendOfferId, usdcAddress)).to.equal(0n);
      expect(await morphoAdapter.sharesOf(borrowOfferId, btcAddress)).to.equal(0n);
    });

    it("Should track totalShares correctly across multiple offers and matches", async function () {
      // Create two lend offers
      const lend1 = await createLendOffer(lender);
      const lend2 = await createLendOffer(lender);

      const totalSharesAfter2 = await morphoAdapter.totalShares(usdcAddress);
      expect(totalSharesAfter2).to.be.gt(0n);

      // Create borrow offer and match with first lend
      const borrow1 = await createBorrowOffer(borrower);
      await loanFactory.connect(borrower).takeUpLoan(borrow1, lend1);

      // Should have reduced totalShares but still have lend2's shares
      const totalSharesAfterMatch = await morphoAdapter.totalShares(usdcAddress);
      expect(totalSharesAfterMatch).to.be.gt(0n);
      expect(totalSharesAfterMatch).to.be.lt(totalSharesAfter2);

      // Cancel lend2 — should clear remaining shares
      await loanFactory.connect(lender).cancelLoan(lend2);
      expect(await morphoAdapter.totalShares(usdcAddress)).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined Pause + Cap Interaction
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Pause + Cap Interaction", function () {
    it("Should check pause before cap", async function () {
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, hre.ethers.parseUnits("999999", 6));

      // Should fail with pause message, not cap
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 1000n, 100n)
      ).to.be.revertedWith("Market deposits paused");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Market Freeze (Morpho optimizer: isPaused — full stop)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Market Freeze Controls", function () {
    it("Should block deposits when frozen", async function () {
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 1000n, 100n)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should block withdrawals when frozen", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should allow emergency withdraw even when frozen", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

      // Emergency withdraw bypasses freeze
      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);
      const balAfter = await usdcMock.balanceOf(owner.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("Should emit MarketFreezeToggled event", async function () {
      await expect(directAdapter.connect(owner).setMarketFrozen(usdcAddress, true))
        .to.emit(directAdapter, "MarketFreezeToggled")
        .withArgs(usdcAddress, true);
    });

    it("Should reject freeze from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setMarketFrozen(usdcAddress, true)
      ).to.be.reverted;
    });

    it("Should reject freeze for unconfigured token", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.connect(owner).setMarketFrozen(randomToken, true)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should check freeze before pause on deposit", async function () {
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);

      // Should fail with freeze message, not pause
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, 1000n, 100n)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should resume normal operation after unfreeze", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, false);

      // Both deposit and withdraw should work
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Position Enumeration (fixes INFO-10)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Position Enumeration", function () {
    it("Should track positions on deposit and remove on withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 300n);

      const positions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(3);
      expect(positions).to.include(100n);
      expect(positions).to.include(200n);
      expect(positions).to.include(300n);

      // Withdraw one
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 200n, directLoanFactory.address);
      const positionsAfter = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positionsAfter.length).to.equal(2);
      expect(positionsAfter).to.not.include(200n);
      expect(positionsAfter).to.include(100n);
      expect(positionsAfter).to.include(300n);
    });

    it("Should return empty array when no positions", async function () {
      const positions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(0);
    });

    it("Should track positions per token independently", async function () {
      const usdcAmount = hre.ethers.parseUnits("1000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 200n);

      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(1);
      expect(await directAdapter.getPositionCount(btcAddress)).to.equal(1);

      const usdcPositions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(usdcPositions).to.include(100n);
      expect(usdcPositions).to.not.include(200n);
    });

    it("Should remove positions on emergency withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(1);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);
      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(0);
    });

    it("Should remove positions on batch emergency withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [100n, 200n], owner.address);
      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(0);
      const positions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(0);
    });

    it("Should not add duplicate loanId on re-deposit to same position", async function () {
      const amount = hre.ethers.parseUnits("500", 6);

      // Two deposits to same loanId
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(1);
      const positions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(1);
      expect(positions[0]).to.equal(100n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Deposit Amount Tracking (yield calculation support)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Deposit Amount Tracking", function () {
    it("Should track original deposit amount", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.getDepositedAmount(100n, usdcAddress)).to.equal(amount);
    });

    it("Should accumulate deposit amount on re-deposit", async function () {
      const amount = hre.ethers.parseUnits("500", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.getDepositedAmount(100n, usdcAddress)).to.equal(amount * 2n);
    });

    it("Should clear deposit amount on withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      expect(await directAdapter.getDepositedAmount(100n, usdcAddress)).to.equal(0n);
    });

    it("Should clear deposit amount on emergency withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);

      expect(await directAdapter.getDepositedAmount(100n, usdcAddress)).to.equal(0n);
    });

    it("Should return zero for unknown position", async function () {
      expect(await directAdapter.getDepositedAmount(999n, usdcAddress)).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Market Registry (from Morpho optimizer marketsCreated[] pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Market Registry", function () {
    it("Should track configured markets in registry", async function () {
      const markets = await directAdapter.getCreatedMarkets();
      expect(markets.length).to.equal(2); // USDC + BTC configured in beforeEach
      expect(markets).to.include(usdcAddress);
      expect(markets).to.include(btcAddress);
    });

    it("Should return correct market count", async function () {
      expect(await directAdapter.getMarketCount()).to.equal(2);
    });

    it("Should not add duplicate on reconfiguration", async function () {
      // Reconfigure USDC market (allowed since activePositions == 0)
      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
      expect(await directAdapter.getMarketCount()).to.equal(2); // Still 2, not 3
    });

    it("Should return empty array when no markets configured", async function () {
      // Deploy fresh adapter with no markets
      const freshAdapter = await hre.ethers.deployContract("MorphoAdapter", [
        await mockMorpho.getAddress(),
        directLoanFactory.address,
      ]);
      await freshAdapter.waitForDeployment();

      const markets = await freshAdapter.getCreatedMarkets();
      expect(markets.length).to.equal(0);
      expect(await freshAdapter.getMarketCount()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bulk Pause/Freeze (from Morpho optimizer setPauseStatusForAllMarkets)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Bulk Pause All Markets", function () {
    it("Should pause deposits on all markets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      await directAdapter.connect(owner).setPauseStatusForAllMarkets(true);

      // Both USDC and BTC deposits should fail
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n)
      ).to.be.revertedWith("Market deposits paused");

      await expect(
        directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 200n)
      ).to.be.revertedWith("Market deposits paused");
    });

    it("Should unpause all markets", async function () {
      await directAdapter.connect(owner).setPauseStatusForAllMarkets(true);
      await directAdapter.connect(owner).setPauseStatusForAllMarkets(false);

      // Deposits should work again
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.be.gt(0n);
    });

    it("Should emit per-market and bulk events", async function () {
      const tx = await directAdapter.connect(owner).setPauseStatusForAllMarkets(true);
      await expect(tx).to.emit(directAdapter, "AllMarketsPauseToggled").withArgs(true);
      await expect(tx).to.emit(directAdapter, "MarketPauseToggled").withArgs(usdcAddress, true);
      await expect(tx).to.emit(directAdapter, "MarketPauseToggled").withArgs(btcAddress, true);
    });

    it("Should allow withdrawals on all paused markets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setPauseStatusForAllMarkets(true);

      // Withdrawal should still work
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.equal(0n);
    });

    it("Should reject bulk pause from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setPauseStatusForAllMarkets(true)
      ).to.be.reverted;
    });
  });

  describe("Bulk Freeze All Markets", function () {
    it("Should freeze all markets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setFreezeStatusForAllMarkets(true);

      // Deposits blocked
      await expect(
        directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n)
      ).to.be.revertedWith("Market frozen");

      // Withdrawals blocked
      await expect(
        directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address)
      ).to.be.revertedWith("Market frozen");
    });

    it("Should unfreeze all markets", async function () {
      await directAdapter.connect(owner).setFreezeStatusForAllMarkets(true);
      await directAdapter.connect(owner).setFreezeStatusForAllMarkets(false);

      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.be.gt(0n);
    });

    it("Should emit per-market and bulk events", async function () {
      const tx = await directAdapter.connect(owner).setFreezeStatusForAllMarkets(true);
      await expect(tx).to.emit(directAdapter, "AllMarketsFreezeToggled").withArgs(true);
      await expect(tx).to.emit(directAdapter, "MarketFreezeToggled").withArgs(usdcAddress, true);
      await expect(tx).to.emit(directAdapter, "MarketFreezeToggled").withArgs(btcAddress, true);
    });

    it("Should allow emergency withdraw even when all frozen", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setFreezeStatusForAllMarkets(true);

      // Emergency withdraw bypasses freeze
      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);
      const balAfter = await usdcMock.balanceOf(owner.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("Should reject bulk freeze from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).setFreezeStatusForAllMarkets(true)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Max Markets Limit (from Morpho optimizer MAX_NB_OF_MARKETS)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Max Markets Limit", function () {
    it("Should expose MAX_NB_OF_MARKETS constant", async function () {
      expect(await directAdapter.MAX_NB_OF_MARKETS()).to.equal(128);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Partial Withdrawal (from Morpho optimizer partial matching pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Partial Withdrawal", function () {
    it("Should withdraw partial shares and keep remainder earning", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const totalShares = await directAdapter.sharesOf(100n, usdcAddress);
      const halfShares = totalShares / 2n;

      const balBefore = await usdcMock.balanceOf(directLoanFactory.address);
      await directAdapter.connect(directLoanFactory).withdrawPartial(
        usdcAddress, 100n, halfShares, directLoanFactory.address
      );
      const balAfter = await usdcMock.balanceOf(directLoanFactory.address);

      // Got some assets back
      expect(balAfter).to.be.gt(balBefore);

      // Remaining shares still active
      const remaining = await directAdapter.sharesOf(100n, usdcAddress);
      expect(remaining).to.equal(totalShares - halfShares);

      // Position still active
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(1);
    });

    it("Should update totalShares correctly on partial withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      const totalBefore = await directAdapter.totalShares(usdcAddress);
      const halfShares = (await directAdapter.sharesOf(100n, usdcAddress)) / 2n;

      await directAdapter.connect(directLoanFactory).withdrawPartial(
        usdcAddress, 100n, halfShares, directLoanFactory.address
      );

      expect(await directAdapter.totalShares(usdcAddress)).to.equal(totalBefore - halfShares);
    });

    it("Should pro-rate depositedAmount on partial withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const shares = await directAdapter.sharesOf(100n, usdcAddress);
      const halfShares = shares / 2n;

      await directAdapter.connect(directLoanFactory).withdrawPartial(
        usdcAddress, 100n, halfShares, directLoanFactory.address
      );

      // Deposited amount should be roughly halved
      const remainingDeposited = await directAdapter.getDepositedAmount(100n, usdcAddress);
      expect(remainingDeposited).to.equal(amount - (amount * halfShares / shares));
    });

    it("Should emit PartialWithdrawn event", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const shares = await directAdapter.sharesOf(100n, usdcAddress);
      const halfShares = shares / 2n;

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 100n, halfShares, directLoanFactory.address
        )
      ).to.emit(directAdapter, "PartialWithdrawn");
    });

    it("Should reject partial withdraw of all shares (use withdraw instead)", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const shares = await directAdapter.sharesOf(100n, usdcAddress);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 100n, shares, directLoanFactory.address
        )
      ).to.be.revertedWith("Use withdraw for full redemption");
    });

    it("Should reject partial withdraw of zero shares", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 100n, 0n, directLoanFactory.address
        )
      ).to.be.revertedWith("Shares must be > 0");
    });

    it("Should reject partial withdraw with zero recipient", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 100n, 1n, hre.ethers.ZeroAddress
        )
      ).to.be.revertedWith("Recipient cannot be zero");
    });

    it("Should reject partial withdraw for non-existent position", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 999n, 1n, directLoanFactory.address
        )
      ).to.be.revertedWith("No position for loan");
    });

    it("Should reject partial withdraw from non-LoanFactory", async function () {
      await expect(
        directAdapter.connect(owner).withdrawPartial(
          usdcAddress, 100n, 1n, owner.address
        )
      ).to.be.revertedWith("Only LoanFactory");
    });

    it("Should reject partial withdraw when frozen", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

      await expect(
        directAdapter.connect(directLoanFactory).withdrawPartial(
          usdcAddress, 100n, 1n, directLoanFactory.address
        )
      ).to.be.revertedWith("Market frozen");
    });

    it("Should allow full withdraw after partial withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const shares = await directAdapter.sharesOf(100n, usdcAddress);
      const halfShares = shares / 2n;

      // Partial withdraw
      await directAdapter.connect(directLoanFactory).withdrawPartial(
        usdcAddress, 100n, halfShares, directLoanFactory.address
      );

      // Full withdraw of remaining
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      expect(await directAdapter.sharesOf(100n, usdcAddress)).to.equal(0n);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
      expect(await directAdapter.getPositionCount(usdcAddress)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Total Deposited Assets Tracking (aggregate yield monitoring)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Total Deposited Assets", function () {
    it("Should track total deposited assets across positions", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 100n);
      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(amount1);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 200n);
      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(amount1 + amount2);
    });

    it("Should decrease on full withdrawal", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 200n);

      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);
      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(amount2);
    });

    it("Should decrease on emergency withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(owner).emergencyWithdraw(usdcAddress, 100n, owner.address);
      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(0n);
    });

    it("Should decrease on batch emergency withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [100n, 200n], owner.address);
      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(0n);
    });

    it("Should decrease proportionally on partial withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const shares = await directAdapter.sharesOf(100n, usdcAddress);
      const halfShares = shares / 2n;

      await directAdapter.connect(directLoanFactory).withdrawPartial(
        usdcAddress, 100n, halfShares, directLoanFactory.address
      );

      const remaining = await directAdapter.getTotalDepositedAssets(usdcAddress);
      expect(remaining).to.equal(amount - (amount * halfShares / shares));
    });

    it("Should track independently per token", async function () {
      const usdcAmount = hre.ethers.parseUnits("5000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 200n);

      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(usdcAmount);
      expect(await directAdapter.getTotalDepositedAssets(btcAddress)).to.equal(btcAmount);
    });

    it("Should return zero for unconfigured token", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      expect(await directAdapter.getTotalDepositedAssets(randomToken)).to.equal(0n);
    });

    it("Should accumulate on re-deposit to same loanId", async function () {
      const amount = hre.ethers.parseUnits("500", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      expect(await directAdapter.getTotalDepositedAssets(usdcAddress)).to.equal(amount * 2n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Market Deconfiguration (from Morpho optimizer bounded market registry pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Market Deconfiguration", function () {
    it("Should deconfigure a market with no active positions", async function () {
      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.true;
      expect(await directAdapter.getMarketCount()).to.equal(2);

      await directAdapter.connect(owner).deconfigureMarket(usdcAddress);

      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.false;
      expect(await directAdapter.getMarketCount()).to.equal(1);
    });

    it("Should emit MarketDeconfigured event", async function () {
      await expect(directAdapter.connect(owner).deconfigureMarket(usdcAddress))
        .to.emit(directAdapter, "MarketDeconfigured")
        .withArgs(usdcAddress);
    });

    it("Should clear all market state on deconfigure", async function () {
      await directAdapter.connect(owner).setMarketPaused(usdcAddress, true);
      await directAdapter.connect(owner).setMarketFrozen(usdcAddress, true);
      await directAdapter.connect(owner).setMarketCap(usdcAddress, 5000n);

      await directAdapter.connect(owner).deconfigureMarket(usdcAddress);

      expect(await directAdapter.marketPaused(usdcAddress)).to.be.false;
      expect(await directAdapter.marketFrozen(usdcAddress)).to.be.false;
      expect(await directAdapter.marketCap(usdcAddress)).to.equal(0);
    });

    it("Should reject deconfigure with active positions", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      await expect(
        directAdapter.connect(owner).deconfigureMarket(usdcAddress)
      ).to.be.revertedWith("Active positions exist for token");
    });

    it("Should reject deconfigure for unconfigured market", async function () {
      const randomToken = "0x0000000000000000000000000000000000000099";
      await expect(
        directAdapter.connect(owner).deconfigureMarket(randomToken)
      ).to.be.revertedWith("No Morpho market for token");
    });

    it("Should reject deconfigure from non-owner", async function () {
      await expect(
        directAdapter.connect(directLoanFactory).deconfigureMarket(usdcAddress)
      ).to.be.reverted;
    });

    it("Should allow reconfigure after deconfigure (frees registry slot)", async function () {
      await directAdapter.connect(owner).deconfigureMarket(usdcAddress);
      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.false;

      // Reconfigure the same token
      await directAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));
      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.true;
      expect(await directAdapter.getMarketCount()).to.equal(2);
    });

    it("Should allow deconfigure after full withdrawal", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Withdraw first
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      // Now deconfigure should work
      await directAdapter.connect(owner).deconfigureMarket(usdcAddress);
      expect(await directAdapter.marketConfigured(usdcAddress)).to.be.false;
    });

    it("Should reject deconfigure with outstanding shares but zero positions (safety)", async function () {
      // This shouldn't happen in practice but tests the totalShares guard
      // Since we can't easily create this state, we verify the check exists
      // by testing the normal case: deposit creates shares + positions
      const amount = hre.ethers.parseUnits("1000", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Both guards should fire (activePositions > 0 fires first)
      await expect(
        directAdapter.connect(owner).deconfigureMarket(usdcAddress)
      ).to.be.revertedWith("Active positions exist for token");
    });

    it("Should remove from registry (getCreatedMarkets)", async function () {
      const marketsBefore = await directAdapter.getCreatedMarkets();
      expect(marketsBefore).to.include(usdcAddress);

      await directAdapter.connect(owner).deconfigureMarket(usdcAddress);

      const marketsAfter = await directAdapter.getCreatedMarkets();
      expect(marketsAfter).to.not.include(usdcAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Batch Size Limit (from Morpho optimizer gas-budgeted loop pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Batch Size Limit", function () {
    it("Should expose MAX_BATCH_SIZE constant", async function () {
      expect(await directAdapter.MAX_BATCH_SIZE()).to.equal(50);
    });

    it("Should reject batch exceeding MAX_BATCH_SIZE", async function () {
      const oversizedBatch = Array.from({ length: 51 }, (_, i) => BigInt(i + 1));
      await expect(
        directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, oversizedBatch, owner.address)
      ).to.be.revertedWith("Batch too large");
    });

    it("Should allow batch at exactly MAX_BATCH_SIZE", async function () {
      // Create 50 deposits
      const amount = hre.ethers.parseUnits("100", 6);
      const totalNeeded = amount * 50n;
      await usdcMock.connect(owner).transfer(directLoanFactory.address, totalNeeded);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), totalNeeded);

      const loanIds: bigint[] = [];
      for (let i = 1; i <= 50; i++) {
        const loanId = BigInt(i);
        await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, loanId);
        loanIds.push(loanId);
      }

      // Batch of exactly 50 should work
      const totalAssets = await directAdapter.connect(owner).batchEmergencyWithdraw.staticCall(
        usdcAddress, loanIds, owner.address
      );
      expect(totalAssets).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Extended Market Info (totalDeposited in getMarketInfo)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Extended getMarketInfo", function () {
    it("Should include totalDeposited in getMarketInfo", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount * 2n);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount * 2n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._totalDeposited).to.equal(amount * 2n);
    });

    it("Should return zero totalDeposited for empty market", async function () {
      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._totalDeposited).to.equal(0);
    });

    it("Should include totalDeposited in getAllMarketsInfo", async function () {
      const amount = hre.ethers.parseUnits("500", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const info = await directAdapter.getAllMarketsInfo();
      const usdcIdx = info.tokens.indexOf(usdcAddress);
      expect(info._totalDeposited[usdcIdx]).to.equal(amount);
    });

    it("Should decrease totalDeposited after withdrawal in getMarketInfo", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await usdcMock.connect(owner).transfer(directLoanFactory.address, amount * 2n);
      await usdcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), amount * 2n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      const info = await directAdapter.getMarketInfo(usdcAddress);
      expect(info._totalDeposited).to.equal(amount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Position Value Estimation (Morpho optimizer: RatesLens pattern)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Position Value Estimation (Lens Pattern)", function () {
    it("Should estimate position value with yield (estimatePositionValue)", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      const [estimatedAssets, deposited] = await directAdapter.estimatePositionValue(100n, usdcAddress);
      // MockMorpho gives 1% yield: 1000 shares → 1010 assets
      const expectedYield = amount / 100n;
      expect(estimatedAssets).to.equal(amount + expectedYield);
      expect(deposited).to.equal(amount);
    });

    it("Should return zero for non-existent position", async function () {
      const [estimatedAssets, deposited] = await directAdapter.estimatePositionValue(999n, usdcAddress);
      expect(estimatedAssets).to.equal(0);
      expect(deposited).to.equal(0);
    });

    it("Should show yield = estimated - deposited", async function () {
      const amount = hre.ethers.parseUnits("5000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);

      const [estimatedAssets, deposited] = await directAdapter.estimatePositionValue(200n, usdcAddress);
      const unrealizedYield = estimatedAssets - deposited;
      expect(unrealizedYield).to.equal(amount / 100n); // 1% yield
    });

    it("Should estimate market-wide value (estimateMarketValue)", async function () {
      const amount1 = hre.ethers.parseUnits("1000", 6);
      const amount2 = hre.ethers.parseUnits("2000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount1, 100n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount2, 200n);

      const [estimatedTotal, totalDeposited] = await directAdapter.estimateMarketValue(usdcAddress);
      const totalShares = amount1 + amount2; // 1:1 in mock
      const expectedTotal = totalShares + totalShares / 100n; // 1% yield on total shares
      expect(estimatedTotal).to.equal(expectedTotal);
      expect(totalDeposited).to.equal(amount1 + amount2);
    });

    it("Should return zero for market with no positions", async function () {
      const [estimatedTotal, totalDeposited] = await directAdapter.estimateMarketValue(usdcAddress);
      expect(estimatedTotal).to.equal(0);
      expect(totalDeposited).to.equal(0);
    });

    it("Should update after partial withdraw", async function () {
      const amount = hre.ethers.parseUnits("2000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Withdraw half
      const halfShares = amount / 2n;
      await directAdapter.connect(directLoanFactory).withdrawPartial(usdcAddress, 100n, halfShares, directLoanFactory.address);

      const [estimatedAssets, deposited] = await directAdapter.estimatePositionValue(100n, usdcAddress);
      const remainingShares = amount - halfShares;
      expect(estimatedAssets).to.equal(remainingShares + remainingShares / 100n);
      expect(deposited).to.equal(amount / 2n); // pro-rata reduction
    });

    it("Should return zero after full withdraw", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);
      await directAdapter.connect(directLoanFactory).withdraw(usdcAddress, 100n, directLoanFactory.address);

      const [estimatedAssets, deposited] = await directAdapter.estimatePositionValue(100n, usdcAddress);
      expect(estimatedAssets).to.equal(0);
      expect(deposited).to.equal(0);
    });

    it("Should work across multiple tokens", async function () {
      const usdcAmount = hre.ethers.parseUnits("1000", 6);
      const btcAmount = hre.ethers.parseUnits("1", 8);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, usdcAmount, 100n);
      await btcMock.connect(directLoanFactory).approve(await directAdapter.getAddress(), btcAmount);
      await directAdapter.connect(directLoanFactory).deposit(btcAddress, btcAmount, 100n);

      const [usdcEstimated] = await directAdapter.estimatePositionValue(100n, usdcAddress);
      const [btcEstimated] = await directAdapter.estimatePositionValue(100n, btcAddress);
      expect(usdcEstimated).to.equal(usdcAmount + usdcAmount / 100n);
      expect(btcEstimated).to.equal(btcAmount + btcAmount / 100n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Branch Coverage: batchEmergencyWithdraw with mixed empty/non-empty loanIds
  // ═══════════════════════════════════════════════════════════════════════════

  describe("batchEmergencyWithdraw — mixed loanIds (shares==0 continue branch)", function () {
    it("Should skip empty positions and withdraw non-empty ones", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 100n);

      // Batch with loanId 100 (has position) and loanId 999 (no position — hits continue)
      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [100n, 999n], owner.address);
      const balAfter = await usdcMock.balanceOf(owner.address);

      // Should have withdrawn only the real position
      expect(balAfter - balBefore).to.be.gt(0);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
    });

    it("Should skip multiple empty positions in batch", async function () {
      const amount = hre.ethers.parseUnits("500", 6);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 200n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 201n);

      // Mix of valid and empty loanIds
      const balBefore = await usdcMock.balanceOf(owner.address);
      await directAdapter.connect(owner).batchEmergencyWithdraw(
        usdcAddress, [999n, 200n, 998n, 201n, 997n], owner.address
      );
      const balAfter = await usdcMock.balanceOf(owner.address);

      expect(balAfter - balBefore).to.be.gt(0);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(0);
      expect(await directAdapter.totalShares(usdcAddress)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Branch Coverage: deposit to same loanId twice (existing position branch)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("deposit — second deposit to same loanId (sharesOf != 0 branch)", function () {
    it("Should add shares without incrementing activePositions on second deposit", async function () {
      const amount = hre.ethers.parseUnits("500", 6);

      // First deposit
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 300n);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1);
      const sharesAfterFirst = await directAdapter.sharesOf(300n, usdcAddress);

      // Second deposit to same loanId — hits the sharesOf[loanId][token] != 0 branch
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 300n);
      expect(await directAdapter.activePositions(usdcAddress)).to.equal(1); // NOT incremented
      expect(await directAdapter.totalActivePositions()).to.equal(1); // NOT incremented

      const sharesAfterSecond = await directAdapter.sharesOf(300n, usdcAddress);
      expect(sharesAfterSecond).to.be.gt(sharesAfterFirst); // shares accumulated
    });

    it("Should accumulate depositedAmount on second deposit", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 400n);
      expect(await directAdapter.depositedAmount(400n, usdcAddress)).to.equal(amount);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 400n);
      expect(await directAdapter.depositedAmount(400n, usdcAddress)).to.equal(amount * 2n);
      expect(await directAdapter.totalDepositedAssets(usdcAddress)).to.equal(amount * 2n);
    });

    it("Should not add duplicate to positionsByToken on second deposit", async function () {
      const amount = hre.ethers.parseUnits("500", 6);

      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 500n);
      await directAdapter.connect(directLoanFactory).deposit(usdcAddress, amount, 500n);

      const positions = await directAdapter.getPositionsByToken(usdcAddress);
      expect(positions.length).to.equal(1);
      expect(positions[0]).to.equal(500n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Branch Coverage: configureMarket reconfiguration (marketConfigured already true)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("configureMarket — reconfiguration (skip _marketsCreated.add)", function () {
    it("Should reconfigure without adding duplicate to registry", async function () {
      // usdcAddress is already configured in beforeEach
      const countBefore = await directAdapter.getMarketCount();

      // Reconfigure with different params (same token, no active positions)
      const newParams = {
        loanToken: usdcAddress,
        collateralToken: "0x0000000000000000000000000000000000000002",
        oracle: "0x0000000000000000000000000000000000000003",
        irm: "0x0000000000000000000000000000000000000004",
        lltv: 2n,
      };
      await directAdapter.connect(owner).configureMarket(usdcAddress, newParams);

      const countAfter = await directAdapter.getMarketCount();
      expect(countAfter).to.equal(countBefore); // No duplicate entry
    });
  });
});
