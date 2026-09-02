import { expect } from "chai";
import { ethers } from "hardhat";
import { fastForwardTime } from "../utils/loanHelpers";
import hre from "hardhat";

/**
 * End-to-end: full loan lifecycle with GPU compute-hour collateral priced by
 * PostedPriceFeed (OCPI B200 index) instead of a Chainlink feed.
 *
 * Deploys its own stack (B200H token + adapter + registry + oracle + factory)
 * rather than the shared BTC-based fixture in tests/utils/deployments.ts.
 */

// OCPI B200 settle: $6.51/hr with 8 feed decimals
const OCPI_B200_PRICE = hre.ethers.parseUnits("6.51", 8);
const FEED_DECIMALS = 8;
const USDC_DECIMALS = 6;

// Loan terms shared by both offers (must match for takeUpLoan)
const INITIAL_COLLATERAL_RATIO = 12000; // 120%
const LIQUIDATION_THRESHOLD = 11000;    // 110%

describe("Ornn compute collateral end-to-end", function () {
  let usdc: any;
  let b200h: any;
  let adapter: any;
  let oracle: any;
  let registry: any;
  let factory: any;
  let calculator: any;
  let owner: any;
  let lender: any;
  let borrower: any;

  // 2,000 B200 hours at $6.51/hr = $13,020 — covers 120% of a 10,000 USDC loan
  const COLLATERAL = hre.ethers.parseUnits("2000", 18);
  const LOAN_AMOUNT = hre.ethers.parseUnits("10000", 6);

  beforeEach(async function () {
    [owner, lender, borrower] = await hre.ethers.getSigners();

    usdc = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, hre.ethers.parseUnits("1000000", 6), 6
    ]);
    b200h = await hre.ethers.deployContract("ERC20Mock", [
      "B200 Compute Hour", "B200H", owner.address, hre.ethers.parseUnits("100000", 18), 18
    ]);
    await usdc.waitForDeployment();
    await b200h.waitForDeployment();

    adapter = await hre.ethers.deployContract("PostedPriceFeed", [
      owner.address, FEED_DECIMALS, "OCPI B200 / USD"
    ]);
    await adapter.waitForDeployment();
    await adapter.postAnswer(OCPI_B200_PRICE);

    registry = await hre.ethers.deployContract("AssetRegistry");
    await registry.waitForDeployment();
    await registry.registerAsset(await b200h.getAddress(), "B200H", "OCPI-B200/USD", 18);
    await registry.registerAsset(await usdc.getAddress(), "USDC", "", 6);
    await registry.setAssetSupported(await b200h.getAddress(), true);
    await registry.setAssetSupported(await usdc.getAddress(), true);
    await registry.setPairSupported(await b200h.getAddress(), await usdc.getAddress(), true);

    oracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
    await oracle.waitForDeployment();
    await oracle.setFeed(await b200h.getAddress(), await adapter.getAddress(), 26 * 3600);

    factory = await hre.ethers.deployContract("LoanFactory", [
      await oracle.getAddress(),
      await registry.getAddress(),
      hre.ethers.ZeroAddress, // no protocol fee
      0
    ]);
    await factory.waitForDeployment();

    calculator = await hre.ethers.deployContract("LoanCalculatorTest");
    await calculator.waitForDeployment();
  });

  async function createMatchedLoan(rateIndex: number, durationIndex: number) {
    const factoryAddr = await factory.getAddress();

    // Borrower commits 2,000 B200H as a borrow offer
    await b200h.transfer(borrower.address, COLLATERAL);
    await b200h.connect(borrower).approve(factoryAddr, COLLATERAL);
    const borrowTx = await factory.connect(borrower).createLoan(
      0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), rateIndex, durationIndex
    );
    await borrowTx.wait();
    const borrowOfferId = 1n;

    // Lender commits 10,000 USDC as a lend offer
    await usdc.transfer(lender.address, LOAN_AMOUNT);
    await usdc.connect(lender).approve(factoryAddr, LOAN_AMOUNT);
    const lendTx = await factory.connect(lender).createLoan(
      LOAN_AMOUNT, 0, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), rateIndex, durationIndex
    );
    await lendTx.wait();
    const lendOfferId = 2n;

    // Borrower matches: collateral valued through PostedPriceFeed at takeUp
    await expect(factory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.emit(factory, "TakeUp")
      .withArgs(borrower.address, lender.address);

    const loan = await factory.loans(lendOfferId);
    expect(loan.s).to.equal(2); // s3 = active
    expect(loan.collateral).to.equal(COLLATERAL);
    expect(loan.asset).to.equal(LOAN_AMOUNT);

    // Borrower received the lent USDC
    expect(await usdc.balanceOf(borrower.address)).to.equal(LOAN_AMOUNT);

    return lendOfferId;
  }

  it("Should run the full lifecycle: offer → match → repay at maturity, priced by OCPI", async function () {
    const rateIndex = 1;     // 5% annual
    const durationIndex = 0; // 1 day
    const loanId = await createMatchedLoan(rateIndex, durationIndex);
    const factoryAddr = await factory.getAddress();

    // Fund borrower for repayment (principal + interest, with headroom)
    const totalRepayment = await calculator.testCalculateTotalRepayment(
      LOAN_AMOUNT,
      await factory.RATE_BPS(rateIndex),
      await factory.DURATION_DAYS(durationIndex)
    );
    const headroom = (totalRepayment * 105n) / 100n;
    await usdc.transfer(borrower.address, headroom);
    await usdc.connect(borrower).approve(factoryAddr, headroom);

    // Simulate the next daily OCPI settle (+1%) landing before maturity
    await fastForwardTime(1);
    await adapter.postAnswer((OCPI_B200_PRICE * 101n) / 100n);

    await expect(factory.connect(borrower).endLoan(loanId)).to.emit(factory, "Ended");

    // Loan is deleted
    const loan = await factory.loans(loanId);
    expect(loan.id).to.equal(0);

    // Lender's yield is paid in B200H at the adapter's latest posted price
    const expectedPayout = await calculator.testCalculateCollateralPayout.staticCall(
      LOAN_AMOUNT,
      await factory.RATE_BPS(rateIndex),
      await factory.DURATION_DAYS(durationIndex),
      COLLATERAL,
      await b200h.getAddress(),
      USDC_DECIMALS,
      await oracle.getAddress()
    );
    expect(await b200h.balanceOf(lender.address)).to.equal(expectedPayout);
    expect(expectedPayout).to.be.greaterThan(0);

    // Borrower gets the excess collateral back; factory holds nothing
    const excess = await b200h.balanceOf(borrower.address);
    expect(excess + expectedPayout).to.equal(COLLATERAL);
    expect(await b200h.balanceOf(factoryAddr)).to.equal(0n);
    expect(await usdc.balanceOf(factoryAddr)).to.equal(0n);
  });

  it("Should liquidate when the compute price crashes below the threshold", async function () {
    const rateIndex = 7;     // 11% annual
    const durationIndex = 5; // 365 days
    const loanId = await createMatchedLoan(rateIndex, durationIndex);
    const factoryAddr = await factory.getAddress();

    // Healthy loan cannot be liquidated
    await expect(factory.connect(lender).liquidateLoan(loanId)).to.be.reverted;

    // Compute glut: B200 rental price drops 40% ($6.51 → $3.906)
    // Collateral value: 2,000 × $3.906 = $7,812 < 110% × $10,000 = $11,000 → liquidatable
    // (-40% also stays within PriceOracle's 50% deviation circuit breaker)
    await adapter.postAnswer((OCPI_B200_PRICE * 60n) / 100n);

    await expect(factory.connect(lender).liquidateLoan(loanId))
      .to.emit(factory, "Liquidated");

    // Lender receives all collateral; loan is deleted; factory holds nothing
    expect(await b200h.balanceOf(lender.address)).to.equal(COLLATERAL);
    const loan = await factory.loans(loanId);
    expect(loan.id).to.equal(0);
    expect(await b200h.balanceOf(factoryAddr)).to.equal(0n);
    expect(await usdc.balanceOf(factoryAddr)).to.equal(0n);
  });

  it("Should serve WBTC (Chainlink-style) and compute collateral loans concurrently in one factory", async function () {
    const factoryAddr = await factory.getAddress();

    // Onboard WBTC alongside B200H: same registry/oracle, its own feed
    const btc = await hre.ethers.deployContract("ERC20Mock", [
      "Wrapped Bitcoin", "WBTC", owner.address, hre.ethers.parseUnits("100", 8), 8
    ]);
    await btc.waitForDeployment();
    const btcFeed = await hre.ethers.deployContract("MockAggregatorV3", [
      8, 50_000n * 10n ** 8n // $50,000
    ]);
    await btcFeed.waitForDeployment();
    await registry.registerAsset(await btc.getAddress(), "WBTC", "BTC/USD", 8);
    await registry.setAssetSupported(await btc.getAddress(), true);
    await registry.setPairSupported(await btc.getAddress(), await usdc.getAddress(), true);
    await oracle.setFeed(await btc.getAddress(), await btcFeed.getAddress(), 400 * 24 * 3600);

    // Loan 1: 0.5 WBTC ($25,000) collateralizing 10,000 USDC
    const btcCollateral = hre.ethers.parseUnits("0.5", 8);
    await btc.transfer(borrower.address, btcCollateral);
    await btc.connect(borrower).approve(factoryAddr, btcCollateral);
    await factory.connect(borrower).createLoan(
      0, btcCollateral, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await btc.getAddress(), 1, 2
    ); // id 1
    await usdc.transfer(lender.address, LOAN_AMOUNT);
    await usdc.connect(lender).approve(factoryAddr, LOAN_AMOUNT);
    await factory.connect(lender).createLoan(
      LOAN_AMOUNT, 0, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await btc.getAddress(), 1, 2
    ); // id 2
    await factory.connect(borrower).takeUpLoan(1, 2);

    // Loan 2: 2,000 B200H ($13,020 via PostedPriceFeed) collateralizing 10,000 USDC
    await b200h.transfer(borrower.address, COLLATERAL);
    await b200h.connect(borrower).approve(factoryAddr, COLLATERAL);
    await factory.connect(borrower).createLoan(
      0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    ); // id 3
    await usdc.transfer(lender.address, LOAN_AMOUNT);
    await usdc.connect(lender).approve(factoryAddr, LOAN_AMOUNT);
    await factory.connect(lender).createLoan(
      LOAN_AMOUNT, 0, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    ); // id 4
    await factory.connect(borrower).takeUpLoan(3, 4);

    // Both loans active in the same factory, each priced by its own feed
    const btcLoan = await factory.loans(2);
    const computeLoan = await factory.loans(4);
    expect(btcLoan.s).to.equal(2);
    expect(btcLoan.collateralAddress).to.equal(await btc.getAddress());
    expect(computeLoan.s).to.equal(2);
    expect(computeLoan.collateralAddress).to.equal(await b200h.getAddress());

    // Borrower received both loan payouts
    expect(await usdc.balanceOf(borrower.address)).to.equal(LOAN_AMOUNT * 2n);
  });

  it("Should let the borrower top up compute collateral to escape liquidation", async function () {
    const loanId = await createMatchedLoan(7, 5); // 11% / 365 days
    const factoryAddr = await factory.getAddress();

    // Crash: $6.51 → $3.906. Collateral value $7,812 < 110% × $10,000 → liquidatable
    await adapter.postAnswer((OCPI_B200_PRICE * 60n) / 100n);

    // Borrower tops up 1,000 more hours: 3,000 × $3.906 = $11,718 > $11,000
    const topUpAmount = hre.ethers.parseUnits("1000", 18);
    await b200h.transfer(borrower.address, topUpAmount);
    await b200h.connect(borrower).approve(factoryAddr, topUpAmount);
    await expect(factory.connect(borrower).topUp(loanId, topUpAmount))
      .to.emit(factory, "ToppedUp");

    // Loan is healthy again — liquidation reverts
    await expect(factory.connect(lender).liquidateLoan(loanId)).to.be.reverted;

    const loan = await factory.loans(loanId);
    expect(loan.collateral).to.equal(COLLATERAL + topUpAmount);
  });

  it("Should reject takeUp when a price drop leaves the offer undercollateralized", async function () {
    const factoryAddr = await factory.getAddress();

    // Offers created at $6.51: 2,000 B200H = $13,020 > 120% × $10,000 = $12,000
    await b200h.transfer(borrower.address, COLLATERAL);
    await b200h.connect(borrower).approve(factoryAddr, COLLATERAL);
    await factory.connect(borrower).createLoan(
      0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    );
    await usdc.transfer(lender.address, LOAN_AMOUNT);
    await usdc.connect(lender).approve(factoryAddr, LOAN_AMOUNT);
    await factory.connect(lender).createLoan(
      LOAN_AMOUNT, 0, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    );

    // Next settle drops 20%: 2,000 × $5.208 = $10,416 < $12,000 required
    await adapter.postAnswer((OCPI_B200_PRICE * 80n) / 100n);

    await expect(
      factory.connect(borrower).takeUpLoan(1, 2)
    ).to.be.revertedWith("Collateral insufficient: phi(z) must be > max(rho*v, c*v)");
  });

  it("Should block new borrow offers when a posted price trips the deviation circuit breaker", async function () {
    const factoryAddr = await factory.getAddress();

    // First borrow offer seeds the oracle's lastGoodPrice at $6.51
    await b200h.transfer(borrower.address, COLLATERAL * 2n);
    await b200h.connect(borrower).approve(factoryAddr, COLLATERAL * 2n);
    await factory.connect(borrower).createLoan(
      0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    );

    // A +60% posted price exceeds PriceOracle's 50% deviation limit —
    // createLoan's checked oracle read refuses to value collateral with it
    await adapter.postAnswer((OCPI_B200_PRICE * 160n) / 100n);

    await expect(
      factory.connect(borrower).createLoan(
        0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
        await usdc.getAddress(), await b200h.getAddress(), 1, 2
      )
    ).to.be.revertedWithCustomError(oracle, "PriceDeviationTooLarge");
  });

  it("Should block matching when the OCPI feed has gone stale", async function () {
    const factoryAddr = await factory.getAddress();

    // Offers can be created (no oracle read for the lend side)
    await b200h.transfer(borrower.address, COLLATERAL);
    await b200h.connect(borrower).approve(factoryAddr, COLLATERAL);
    await factory.connect(borrower).createLoan(
      0, COLLATERAL, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    );

    await usdc.transfer(lender.address, LOAN_AMOUNT);
    await usdc.connect(lender).approve(factoryAddr, LOAN_AMOUNT);
    await factory.connect(lender).createLoan(
      LOAN_AMOUNT, 0, INITIAL_COLLATERAL_RATIO, LIQUIDATION_THRESHOLD,
      await usdc.getAddress(), await b200h.getAddress(), 1, 2
    );

    // Poster misses two daily settles → feed is stale past the 26h window
    await fastForwardTime(2);

    await expect(
      factory.connect(borrower).takeUpLoan(1, 2)
    ).to.be.revertedWithCustomError(oracle, "StalePrice");
  });
});
