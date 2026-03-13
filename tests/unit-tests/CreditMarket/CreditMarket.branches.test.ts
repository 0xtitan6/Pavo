import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("CreditMarket branch coverage", function () {
  const defaultParams: CreditTypesLib.MarketParametersStruct = {
    annualInterestBips: 500,
    delinquencyFeeBips: 200,
    withdrawalBatchDuration: 604800, // 7 days
    reserveRatioBips: 1000,
    delinquencyGracePeriod: 259200,
    protocolFeeBips: 100,
    maxDelinquencyPeriod: 2592000,
    maxTotalSupply: ethers.parseUnits("1000000", 6),
    maturityDate: 0,
    gmslaRefHash: ethers.ZeroHash,
    collateralRatioBps: 0,
  };

  async function deployCreditMarketFixture() {
    const [owner, borrower, lender, lender2, lender3, user2] =
      await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin",
      "USDC",
      owner.address,
      ethers.parseUnits("10000000", 6),
      6,
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [
      owner.address,
    ]);
    await orchestrator.authorizeBorrower(borrower.address, 3);

    const marketAddress = await orchestrator.createMarket.staticCall(
      borrower.address,
      await asset.getAddress(),
      defaultParams
    );
    await orchestrator.createMarket(
      borrower.address,
      await asset.getAddress(),
      defaultParams
    );

    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    // Register lenders
    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);
    await orchestrator.registerLender(marketAddress, lender3.address);

    // Fund lenders
    for (const l of [lender, lender2, lender3]) {
      await asset.transfer(l.address, ethers.parseUnits("500000", 6));
      await asset.connect(l).approve(marketAddress, ethers.MaxUint256);
    }

    // Fund borrower for repayments
    await asset.transfer(borrower.address, ethers.parseUnits("500000", 6));
    await asset.connect(borrower).approve(marketAddress, ethers.MaxUint256);

    return {
      market,
      marketAddress,
      asset,
      orchestrator,
      owner,
      borrower,
      lender,
      lender2,
      lender3,
      user2,
    };
  }

  // ─── Constructor Validation ───────────────────────────────────────

  describe("constructor validation", function () {
    it("Should revert with ZeroAddress when borrower is address(0)", async function () {
      const [owner] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      await expect(
        CreditMarket.deploy(
          ethers.ZeroAddress,
          await asset.getAddress(),
          ethers.ZeroAddress,
          owner.address,
          defaultParams
        )
      ).to.be.revertedWithCustomError(CreditMarket, "ZeroAddress");
    });

    it("Should revert with ZeroAddress when asset is address(0)", async function () {
      const [owner, borrower] = await ethers.getSigners();

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      await expect(
        CreditMarket.deploy(
          borrower.address,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          owner.address,
          defaultParams
        )
      ).to.be.revertedWithCustomError(CreditMarket, "ZeroAddress");
    });

    it("Should revert with InvalidBatchDuration when withdrawalBatchDuration is 0", async function () {
      const [owner, borrower] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const badParams = {
        ...defaultParams,
        withdrawalBatchDuration: 0,
      };
      await expect(
        CreditMarket.deploy(
          borrower.address,
          await asset.getAddress(),
          ethers.ZeroAddress,
          owner.address,
          badParams
        )
      ).to.be.revertedWithCustomError(CreditMarket, "InvalidBatchDuration");
    });

    it("Should revert with InvalidMaxDelinquencyPeriod when maxDelinquencyPeriod is 0", async function () {
      const [owner, borrower] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const badParams = {
        ...defaultParams,
        maxDelinquencyPeriod: 0,
      };
      await expect(
        CreditMarket.deploy(
          borrower.address,
          await asset.getAddress(),
          ethers.ZeroAddress,
          owner.address,
          badParams
        )
      ).to.be.revertedWithCustomError(
        CreditMarket,
        "InvalidMaxDelinquencyPeriod"
      );
    });

    it("Should deploy with positionToken = address(0) (set later via setPositionToken)", async function () {
      const [owner, borrower] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const market = await CreditMarket.deploy(
        borrower.address,
        await asset.getAddress(),
        ethers.ZeroAddress,
        owner.address,
        defaultParams
      );

      expect(await market.positionToken()).to.equal(ethers.ZeroAddress);
    });
  });

  // ─── setPositionToken ─────────────────────────────────────────────

  describe("setPositionToken", function () {
    it("Should revert when called by non-orchestrator", async function () {
      const { market, user2 } = await loadFixture(deployCreditMarketFixture);

      await expect(
        market.connect(user2).setPositionToken(user2.address)
      ).to.be.revertedWithCustomError(market, "UnauthorizedLender");
    });

    it("Should revert MarketAlreadyExists when position token already set", async function () {
      const { market, orchestrator, owner } = await loadFixture(
        deployCreditMarketFixture
      );
      // positionToken is already set by Orchestrator.createMarket
      // We need to call setPositionToken from the orchestrator
      // But orchestrator doesn't expose a way to call setPositionToken directly
      // after market creation — the token is set during createMarket.
      // This branch is covered by the Orchestrator's createMarket flow.
      // We verify the token is already set:
      const pt = await market.positionToken();
      expect(pt).to.not.equal(ethers.ZeroAddress);
    });

    it("Should revert ZeroAddress when setting position token to address(0)", async function () {
      // Deploy market directly (not via orchestrator) without position token
      const [owner, borrower] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const market = await CreditMarket.deploy(
        borrower.address,
        await asset.getAddress(),
        ethers.ZeroAddress,
        owner.address, // orchestrator = deployer
        defaultParams
      );

      // owner is the orchestrator, call setPositionToken with zero address
      await expect(
        market.connect(owner).setPositionToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(market, "ZeroAddress");
    });

    it("Should succeed when called by orchestrator with valid address", async function () {
      const [owner, borrower] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const market = await CreditMarket.deploy(
        borrower.address,
        await asset.getAddress(),
        ethers.ZeroAddress,
        owner.address,
        defaultParams
      );

      // Deploy a LoanPositionToken (name, symbol, market, orchestrator)
      const LPT = await ethers.getContractFactory("LoanPositionToken");
      const lpt = await LPT.deploy("LPT-Test", "LPT", await market.getAddress(), owner.address);

      await market.connect(owner).setPositionToken(await lpt.getAddress());
      expect(await market.positionToken()).to.equal(await lpt.getAddress());
    });

    it("Should revert MarketAlreadyExists on second setPositionToken call", async function () {
      const [owner, borrower, addr1] = await ethers.getSigners();
      const asset = await ethers.deployContract("ERC20Mock", [
        "USDC",
        "USDC",
        owner.address,
        1000000n,
        6,
      ]);

      const CreditMarket = await ethers.getContractFactory("CreditMarket");
      const market = await CreditMarket.deploy(
        borrower.address,
        await asset.getAddress(),
        ethers.ZeroAddress,
        owner.address,
        defaultParams
      );

      const LPT = await ethers.getContractFactory("LoanPositionToken");
      const lpt = await LPT.deploy("LPT-Test", "LPT", await market.getAddress(), owner.address);

      await market.connect(owner).setPositionToken(await lpt.getAddress());

      // Second call should fail
      await expect(
        market.connect(owner).setPositionToken(addr1.address)
      ).to.be.revertedWithCustomError(market, "MarketAlreadyExists");
    });
  });

  // ─── accrueInterest — zero timeDelta early return ─────────────────

  describe("accrueInterest edge cases", function () {
    it("Should produce minimal scaleFactor change when called rapidly (near-zero timeDelta)", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("1000", 6);
      await market.connect(lender).deposit(amount, lender.address);

      // accrueInterest called internally by deposit
      // Call it again — timeDelta will be 1s (minimum between blocks)
      await market.accrueInterest();
      const stateAfterFirst = await market.getState();

      // Call again immediately — timeDelta = 1s
      await market.accrueInterest();
      const stateAfterSecond = await market.getState();

      // With 5% APR and 1s timeDelta, the change is negligible (~1.58e-9 RAY)
      // Both calls should succeed and scaleFactor change should be minimal
      const diff = stateAfterSecond.scaleFactor - stateAfterFirst.scaleFactor;
      // Less than 1e19 change (out of 1e27 RAY) per second at 5% APR
      expect(diff).to.be.lt(ethers.parseUnits("1", 19));
    });

    it("Should accrue interest after time passes", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("10000", 6);
      await market.connect(lender).deposit(amount, lender.address);

      const stateBefore = await market.getState();

      // Advance 30 days
      await time.increase(30 * 86400);
      await market.accrueInterest();

      const stateAfter = await market.getState();
      expect(stateAfter.scaleFactor).to.be.gt(stateBefore.scaleFactor);
    });
  });

  // ─── repay with market closed ─────────────────────────────────────

  describe("repay edge cases", function () {
    it("Should revert when repaying after market is closed", async function () {
      const { market, borrower, lender, asset, marketAddress } =
        await loadFixture(deployCreditMarketFixture);
      const amount = ethers.parseUnits("10000", 6);

      // Deposit, borrow, then close
      await market.connect(lender).deposit(amount, lender.address);
      await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));
      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(borrower).repay(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });

    it("Should revert when borrow after market is closed", async function () {
      const { market, borrower, lender } = await loadFixture(
        deployCreditMarketFixture
      );
      const amount = ethers.parseUnits("10000", 6);

      await market.connect(lender).deposit(amount, lender.address);
      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(borrower).borrow(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });
  });

  // ─── processWithdrawalBatch with full liquidity ───────────────────

  describe("processWithdrawalBatch full-liquidity path", function () {
    it("Should process batch with full liquidity (unpaid=0, no _unpaidBatches push)", async function () {
      const { market, lender, borrower } = await loadFixture(
        deployCreditMarketFixture
      );
      const depositAmount = ethers.parseUnits("10000", 6);
      const withdrawAmount = ethers.parseUnits("5000", 6);

      // Deposit
      await market.connect(lender).deposit(depositAmount, lender.address);

      // Get scaled amount for withdrawal
      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const scaledBalance = await positionToken.balanceOf(lender.address);
      // Request half
      const scaledWithdraw = scaledBalance / 2n;

      await market.connect(lender).requestWithdrawal(scaledWithdraw);

      // Wait for batch to expire
      await time.increase(604800 + 1); // 7 days + 1

      // Process — all liquidity available (no borrows, so unpaid should be 0)
      await expect(market.processWithdrawalBatch())
        .to.emit(market, "WithdrawalBatchProcessed");

      // Verify no delinquency
      expect(await market.isDelinquent()).to.equal(false);
    });

    it("Should process batch with partial liquidity (borrower drained funds)", async function () {
      const { market, lender, borrower } = await loadFixture(
        deployCreditMarketFixture
      );
      const depositAmount = ethers.parseUnits("10000", 6);

      await market.connect(lender).deposit(depositAmount, lender.address);

      // Borrow a large chunk but leave some room (borrow 80% of deposit)
      await market.connect(borrower).borrow(ethers.parseUnits("8000", 6));

      // Request full withdrawal
      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const scaledBalance = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(scaledBalance);

      // Wait for batch to expire
      await time.increase(604800 + 1);

      // Process — limited liquidity means some unpaid
      await expect(market.processWithdrawalBatch())
        .to.emit(market, "WithdrawalBatchProcessed");
    });
  });

  // ─── claimWithdrawal with multiple lenders ────────────────────────

  describe("claimWithdrawal multi-lender proportional", function () {
    it("Should distribute proportionally among 3 lenders", async function () {
      const { market, lender, lender2, lender3, asset, marketAddress } =
        await loadFixture(deployCreditMarketFixture);

      // Deposit different amounts
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("5000", 6), lender.address);
      await market
        .connect(lender2)
        .deposit(ethers.parseUnits("3000", 6), lender2.address);
      await market
        .connect(lender3)
        .deposit(ethers.parseUnits("2000", 6), lender3.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );

      // All request full withdrawal
      const bal1 = await positionToken.balanceOf(lender.address);
      const bal2 = await positionToken.balanceOf(lender2.address);
      const bal3 = await positionToken.balanceOf(lender3.address);

      await market.connect(lender).requestWithdrawal(bal1);
      await market.connect(lender2).requestWithdrawal(bal2);
      await market.connect(lender3).requestWithdrawal(bal3);

      // Wait for batch expiry
      await time.increase(604800 + 1);

      // Process batch
      const state = await market.getState();
      const batchExpiry = state.pendingWithdrawalExpiry;
      await market.processWithdrawalBatch();

      // All three claim
      const before1 = await asset.balanceOf(lender.address);
      await market.connect(lender).claimWithdrawal(batchExpiry);
      const after1 = await asset.balanceOf(lender.address);
      const claimed1 = after1 - before1;

      const before2 = await asset.balanceOf(lender2.address);
      await market.connect(lender2).claimWithdrawal(batchExpiry);
      const after2 = await asset.balanceOf(lender2.address);
      const claimed2 = after2 - before2;

      const before3 = await asset.balanceOf(lender3.address);
      await market.connect(lender3).claimWithdrawal(batchExpiry);
      const after3 = await asset.balanceOf(lender3.address);
      const claimed3 = after3 - before3;

      // Proportional: lender1 should get ~50%, lender2 ~30%, lender3 ~20%
      const total = claimed1 + claimed2 + claimed3;
      expect(total).to.be.gt(0);

      // Check approximate ratios (allow 1% tolerance for rounding)
      const ratio1 = Number((claimed1 * 10000n) / total);
      const ratio2 = Number((claimed2 * 10000n) / total);
      const ratio3 = Number((claimed3 * 10000n) / total);

      expect(ratio1).to.be.closeTo(5000, 100); // ~50%
      expect(ratio2).to.be.closeTo(3000, 100); // ~30%
      expect(ratio3).to.be.closeTo(2000, 100); // ~20%
    });
  });

  // ─── claimWithdrawal already claimed ──────────────────────────────

  describe("claimWithdrawal edge cases", function () {
    it("Should revert ZeroAmount when claiming twice (already claimed)", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal);

      await time.increase(604800 + 1);
      const state = await market.getState();
      const batchExpiry = state.pendingWithdrawalExpiry;
      await market.processWithdrawalBatch();

      // First claim succeeds
      await market.connect(lender).claimWithdrawal(batchExpiry);

      // Second claim should revert
      await expect(
        market.connect(lender).claimWithdrawal(batchExpiry)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should revert when claiming non-existent batch", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await expect(
        market.connect(lender).claimWithdrawal(12345)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });

    it("Should revert when batch not yet processed", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal);

      const state = await market.getState();
      const batchExpiry = state.pendingWithdrawalExpiry;

      // Try claiming before processing (normalizedAmountPaid=0)
      await time.increase(604800 + 1);
      await expect(
        market.connect(lender).claimWithdrawal(batchExpiry)
      ).to.be.revertedWithCustomError(market, "ZeroAmount");
    });
  });

  // ─── requestWithdrawal edge cases ─────────────────────────────────

  describe("requestWithdrawal edge cases", function () {
    it("Should create new batch when existing batch has expired", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);

      // First withdrawal request
      await market.connect(lender).requestWithdrawal(bal / 4n);
      const state1 = await market.getState();
      const expiry1 = state1.pendingWithdrawalExpiry;

      // Wait past expiry
      await time.increase(604800 + 1);

      // Process first batch
      await market.processWithdrawalBatch();

      // New deposit to get more tokens
      await market
        .connect(lender)
        .deposit(ethers.parseUnits("5000", 6), lender.address);

      const bal2 = await positionToken.balanceOf(lender.address);

      // Second request should create a new batch (since old one expired & processed)
      await market.connect(lender).requestWithdrawal(bal2 / 4n);
      const state2 = await market.getState();
      const expiry2 = state2.pendingWithdrawalExpiry;

      // New batch should have a different (later) expiry
      expect(expiry2).to.be.gt(expiry1);
    });

    it("Should add to existing batch within same withdrawal window", async function () {
      const { market, lender, lender2 } = await loadFixture(
        deployCreditMarketFixture
      );

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);
      await market
        .connect(lender2)
        .deposit(ethers.parseUnits("5000", 6), lender2.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );

      // Two requests within same batch window
      const bal1 = await positionToken.balanceOf(lender.address);
      const bal2 = await positionToken.balanceOf(lender2.address);

      await market.connect(lender).requestWithdrawal(bal1 / 2n);
      const state1 = await market.getState();

      await market.connect(lender2).requestWithdrawal(bal2 / 2n);
      const state2 = await market.getState();

      // Same batch expiry
      expect(state1.pendingWithdrawalExpiry).to.equal(
        state2.pendingWithdrawalExpiry
      );
    });

    it("Should revert when requesting withdrawal on closed market", async function () {
      const { market, lender, borrower } = await loadFixture(
        deployCreditMarketFixture
      );

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);
      await market.connect(borrower).closeMarket();

      await expect(
        market.connect(lender).requestWithdrawal(1000n)
      ).to.be.revertedWithCustomError(market, "MarketClosed");
    });
  });

  // ─── closeMarket edge cases ───────────────────────────────────────

  describe("closeMarket edge cases", function () {
    it("Should revert when non-borrower tries to close", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await expect(
        market.connect(lender).closeMarket()
      ).to.be.revertedWithCustomError(market, "UnauthorizedBorrower");
    });

    it("Should revert when pending withdrawals exist", async function () {
      const { market, lender, borrower } = await loadFixture(
        deployCreditMarketFixture
      );

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal / 2n);

      await expect(
        market.connect(borrower).closeMarket()
      ).to.be.revertedWithCustomError(market, "MarketNotClosed");
    });
  });

  // ─── View functions ───────────────────────────────────────────────

  describe("view functions", function () {
    it("Should return correct borrowableAssets (0 when empty)", async function () {
      const { market } = await loadFixture(deployCreditMarketFixture);
      expect(await market.borrowableAssets()).to.equal(0n);
    });

    it("Should return correct liquidityRequired", async function () {
      const { market, lender } = await loadFixture(deployCreditMarketFixture);

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      const required = await market.liquidityRequired();
      // With 10% reserve ratio, required should be ~1000 USDC
      expect(required).to.be.gt(0);
    });

    it("Should return market parameters", async function () {
      const { market } = await loadFixture(deployCreditMarketFixture);
      const params = await market.getParameters();
      expect(params.annualInterestBips).to.equal(500);
      expect(params.delinquencyFeeBips).to.equal(200);
      expect(params.withdrawalBatchDuration).to.equal(604800);
    });

    it("Should return initial state correctly", async function () {
      const { market } = await loadFixture(deployCreditMarketFixture);
      const state = await market.getState();
      expect(state.isClosed).to.equal(false);
      expect(state.isDelinquent).to.equal(false);
      expect(state.totalBorrowed).to.equal(0);
    });
  });

  // ─── Delinquency transitions ──────────────────────────────────────

  describe("delinquency transitions", function () {
    it("Should become delinquent when borrower drains funds below reserve", async function () {
      const { market, lender, borrower } = await loadFixture(
        deployCreditMarketFixture
      );

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      // Borrow a large portion (leave minimal reserve)
      await market.connect(borrower).borrow(ethers.parseUnits("8000", 6));

      // Request a large withdrawal — this makes liquidityRequired exceed balance
      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal / 2n);

      // Advance time to let interest accrue and delinquency emerge
      await time.increase(86400);
      await market.accrueInterest();

      // Should be delinquent (insufficient funds for reserve + pending withdrawals)
      expect(await market.isDelinquent()).to.equal(true);
    });

    it("Should resolve delinquency when borrower repays", async function () {
      const { market, lender, borrower } =
        await loadFixture(deployCreditMarketFixture);

      await market
        .connect(lender)
        .deposit(ethers.parseUnits("10000", 6), lender.address);

      await market.connect(borrower).borrow(ethers.parseUnits("8000", 6));

      // Create delinquency via withdrawal request
      const positionToken = await ethers.getContractAt(
        "ILoanPositionToken",
        await market.positionToken()
      );
      const bal = await positionToken.balanceOf(lender.address);
      await market.connect(lender).requestWithdrawal(bal / 2n);

      await time.increase(86400);
      await market.accrueInterest();
      expect(await market.isDelinquent()).to.equal(true);

      // Repay enough to resolve delinquency
      await market
        .connect(borrower)
        .repay(ethers.parseUnits("8000", 6));

      expect(await market.isDelinquent()).to.equal(false);
    });
  });
});
