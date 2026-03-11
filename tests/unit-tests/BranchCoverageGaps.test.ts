/**
 * BranchCoverageGaps.test.ts
 *
 * Targeted tests for remaining uncovered branch paths identified by coverage analysis:
 *
 * LoanFactory:
 *   - endLoan where collateralPayout == 0 (BTC price so high that debt rounds to 0 satoshi)
 *   - H-6 collateral mismatch in lender-takes-borrow path
 *   - M-6 asset mismatch in lender-takes-borrow path
 *   - Collateral insufficient in lender-takes-borrow path
 *   - Negative collateral yield in lender-takes-borrow path (revert)
 *
 * MorphoAdapter:
 *   - Zero shares returned by Morpho supply
 *   - Zero assets returned by Morpho withdraw/withdrawPartial/emergencyWithdraw
 *
 * ParthenonVaultAdapter:
 *   - Zero shares returned by Teller bulkDeposit
 *   - Zero assets returned by Teller bulkWithdraw (withdraw + emergencyWithdraw)
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
  mockAggregator,
  assetRegistry,
  MOCK_BTC_PRICE,
} from "../utils/deployments";
import {
  createLoanAndGetId,
  createLendOfferParams,
  createBorrowOfferParams,
  fastForwardTime,
} from "../utils/loanHelpers";

const LEND_ASSET = hre.ethers.parseUnits("10000", 6);
const BORROW_COLLATERAL = hre.ethers.parseUnits("1", 8);
const RATE_INDEX = 0;
const DURATION_INDEX = 0;
const INITIAL_RATIO = 15000;
const LIQ_THRESHOLD = 11000;

// ═══════════════════════════════════════════════════════════════════════════
// LOANFACTORY — endLoan where collateralPayout == 0
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — endLoan collateralPayout == 0", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  it("Should handle endLoan where collateralPayout rounds to 0 (extreme BTC price)", async function () {
    // Match a loan
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);

    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    const bParams = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);
    await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

    // Fast forward past maturity
    await fastForwardTime(2);

    // Set BTC to $500 trillion — inverse oracle price for ~10001 USDC rounds to 0 satoshi
    // collateralEquivalent = assetAmount * 10^8 / (price * 10^6)
    // With price = 500e12: 10001e6 * 1e8 / (500e12 * 1e8 * 1e6) → 0
    await mockAggregator.setAnswer(500_000_000_000_000n * 10n ** 8n);

    const lenderBtcBefore = await btcMock.balanceOf(lender.address);
    const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);

    await loanFactory.connect(lender).endLoan(lendId);

    const lenderBtcAfter = await btcMock.balanceOf(lender.address);
    const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);

    // collateralPayout = 0, lender gets nothing
    expect(lenderBtcAfter - lenderBtcBefore).to.equal(0n);
    // Borrower gets all collateral back as excess
    expect(borrowerBtcAfter - borrowerBtcBefore).to.equal(BORROW_COLLATERAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOANFACTORY — lender-takes-borrow validation branches
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — lender-takes-borrow validation", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  it("Should revert on asset mismatch in lender-takes-borrow (M-6)", async function () {
    // Deploy a second asset (DAI)
    const dai = await hre.ethers.deployContract("ERC20Mock", [
      "DAI", "DAI", owner.address, hre.ethers.parseUnits("1000000", 18), 18
    ]);
    await dai.waitForDeployment();
    const daiAddr = await dai.getAddress();

    await assetRegistry.registerAsset(daiAddr, "DAI", "DAI/USD", 18);
    await assetRegistry.setAssetSupported(daiAddr, true);
    await assetRegistry.setPairSupported(btcAddress, daiAddr, true);

    // Lend offer with USDC
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    // Borrow offer with DAI (different asset)
    await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
    const bParams = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, daiAddr, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Lender takes borrow offer — should revert on asset mismatch
    await expect(
      loanFactory.connect(lender).takeUpLoan(lendId, borrowId)
    ).to.be.revertedWith("Offers must use the same asset token");
  });

  it("Should revert on collateral mismatch in lender-takes-borrow (H-6)", async function () {
    // Deploy a second collateral token (ETH) with its own oracle feed
    const eth = await hre.ethers.deployContract("ERC20Mock", [
      "ETH", "ETH", owner.address, hre.ethers.parseUnits("1000", 18), 18
    ]);
    await eth.waitForDeployment();
    const ethAddr = await eth.getAddress();

    // ETH/USD feed at $3000
    const { priceOracle } = await import("../utils/deployments");
    const ethFeed = await hre.ethers.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    await ethFeed.waitForDeployment();
    await priceOracle.setFeed(ethAddr, await ethFeed.getAddress(), 400 * 24 * 3600);

    await assetRegistry.registerAsset(ethAddr, "ETH", "ETH/USD", 18);
    await assetRegistry.setAssetSupported(ethAddr, true);
    await assetRegistry.setPairSupported(ethAddr, usdcAddress, true);

    // Lend offer with BTC collateral
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    // Borrow offer with ETH collateral (different collateral) — needs enough value
    const ethCollateral = hre.ethers.parseUnits("100", 18); // 100 ETH = $300k >> $15k required
    await eth.connect(owner).transfer(borrower.address, ethCollateral);
    await eth.connect(borrower).approve(await loanFactory.getAddress(), ethCollateral);
    const bParams = await createBorrowOfferParams(
      ethCollateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, ethAddr
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Lender takes borrow offer — should revert on collateral mismatch
    await expect(
      loanFactory.connect(lender).takeUpLoan(lendId, borrowId)
    ).to.be.revertedWith("Offers must use the same collateral token");
  });

  it("Should revert on insufficient collateral in lender-takes-borrow", async function () {
    // Create valid offers at normal BTC price
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);
    const bParams = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Drop BTC price so collateral is now insufficient for the ratio
    // 1 BTC at $100 = $100 << 150% of $10,000 = $15,000
    await mockAggregator.setAnswer(100n * 10n ** 8n);

    await expect(
      loanFactory.connect(lender).takeUpLoan(lendId, borrowId)
    ).to.be.revertedWith("Collateral insufficient: phi(z) must be > max(rho*v, c*v)");
  });

  it("Should revert on severe negative collateral yield in lender-takes-borrow (MEDIUM-7)", async function () {
    const negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
    await negAdapter.waitForDeployment();

    await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());
    await negAdapter.setSupported(usdcAddress, true);
    await negAdapter.setSupported(btcAddress, true);
    // -50% yield — collateral drops below threshold
    await negAdapter.setYieldBps(5000);

    // Fund adapter
    await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
    await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));

    // Create offers — use collateral that's barely sufficient at full value
    // 1 BTC = $50k. 150% of $10k = $15k. $50k > $15k but $25k (50%) < $15k? No, $25k > $15k.
    // Use smaller collateral: 0.4 BTC = $20k at full value. After -50%: 0.2 BTC = $10k.
    // Required: 150% * $10k = $15k. $10k < $15k → reverts.
    const collateral = hre.ethers.parseUnits("0.4", 8); // 0.4 BTC = $20,000

    // Lend offer
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    // Borrow offer
    await btcMock.connect(owner).transfer(borrower.address, collateral);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), collateral);
    const bParams = await createBorrowOfferParams(
      collateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Lender takes borrow offer — severe negative yield triggers MEDIUM-7 re-validation failure
    await expect(
      loanFactory.connect(lender).takeUpLoan(lendId, borrowId)
    ).to.be.revertedWith("Post-withdrawal collateral insufficient");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOANFACTORY — H-6 collateral mismatch in borrower-takes-lend
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — borrower-takes-lend H-6 collateral mismatch", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  it("Should revert on collateral mismatch in borrower-takes-lend (H-6)", async function () {
    const { priceOracle } = await import("../utils/deployments");

    // Deploy ETH as second collateral
    const eth = await hre.ethers.deployContract("ERC20Mock", [
      "ETH", "ETH", owner.address, hre.ethers.parseUnits("1000", 18), 18
    ]);
    await eth.waitForDeployment();
    const ethAddr = await eth.getAddress();

    const ethFeed = await hre.ethers.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    await ethFeed.waitForDeployment();
    await priceOracle.setFeed(ethAddr, await ethFeed.getAddress(), 400 * 24 * 3600);

    await assetRegistry.registerAsset(ethAddr, "ETH", "ETH/USD", 18);
    await assetRegistry.setAssetSupported(ethAddr, true);
    await assetRegistry.setPairSupported(ethAddr, usdcAddress, true);

    // Lend offer expecting BTC collateral
    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    // Borrow offer with ETH collateral (different!)
    const ethCollateral = hre.ethers.parseUnits("100", 18);
    await eth.connect(owner).transfer(borrower.address, ethCollateral);
    await eth.connect(borrower).approve(await loanFactory.getAddress(), ethCollateral);
    const bParams = await createBorrowOfferParams(
      ethCollateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, ethAddr
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Borrower takes lend offer — should revert on collateral mismatch
    await expect(
      loanFactory.connect(borrower).takeUpLoan(borrowId, lendId)
    ).to.be.revertedWith("Offers must use the same collateral token");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOANFACTORY — exact yield (no surplus, no negative) for else-if false branches
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — exact yield (zero surplus, zero negative)", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  it("Should handle exact-amount collateral yield (no surplus, no negative) in borrower-takes-lend", async function () {
    // MockYieldAdapter with yieldBps=10000 means exact amount returned (no yield change)
    const adapter = await hre.ethers.deployContract("MockYieldAdapter");
    await adapter.waitForDeployment();
    await loanFactory.connect(owner).setYieldAdapter(await adapter.getAddress());
    await adapter.setSupported(usdcAddress, true);
    await adapter.setSupported(btcAddress, true);
    await adapter.setYieldBps(10000); // exactly 100% = no yield

    await usdcMock.connect(owner).transfer(await adapter.getAddress(), hre.ethers.parseUnits("100000", 6));
    await btcMock.connect(owner).transfer(await adapter.getAddress(), hre.ethers.parseUnits("10", 8));

    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);

    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    const bParams = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Borrower takes lend offer — exact yield: no surplus, no negative
    await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

    // Collateral should be unchanged (no negative yield adjustment)
    const loan = await loanFactory.loans(lendId);
    expect(loan.collateral).to.equal(BORROW_COLLATERAL);
  });

  it("Should handle exact-amount collateral yield (no surplus, no negative) in lender-takes-borrow", async function () {
    const adapter = await hre.ethers.deployContract("MockYieldAdapter");
    await adapter.waitForDeployment();
    await loanFactory.connect(owner).setYieldAdapter(await adapter.getAddress());
    await adapter.setSupported(usdcAddress, true);
    await adapter.setSupported(btcAddress, true);
    await adapter.setYieldBps(10000); // exactly 100% = no yield

    await usdcMock.connect(owner).transfer(await adapter.getAddress(), hre.ethers.parseUnits("100000", 6));
    await btcMock.connect(owner).transfer(await adapter.getAddress(), hre.ethers.parseUnits("10", 8));

    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    await btcMock.connect(owner).transfer(borrower.address, BORROW_COLLATERAL);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), BORROW_COLLATERAL);

    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    const bParams = await createBorrowOfferParams(
      BORROW_COLLATERAL, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Lender takes borrow offer — exact yield
    await loanFactory.connect(lender).takeUpLoan(lendId, borrowId);

    const loan = await loanFactory.loans(borrowId);
    expect(loan.collateral).to.equal(BORROW_COLLATERAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOANFACTORY — borrower-takes-lend negative collateral yield (line 456)
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — borrower-takes-lend severe negative collateral yield", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  it("Should revert on severe negative collateral yield in borrower-takes-lend (MEDIUM-7)", async function () {
    const negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
    await negAdapter.waitForDeployment();

    await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());
    await negAdapter.setSupported(usdcAddress, true);
    await negAdapter.setSupported(btcAddress, true);
    await negAdapter.setYieldBps(5000); // -50% yield

    await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
    await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));

    // 0.4 BTC = $20k at full. After -50%: 0.2 BTC = $10k. Required: 150% * $10k = $15k. Reverts.
    const collateral = hre.ethers.parseUnits("0.4", 8);

    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    await btcMock.connect(owner).transfer(borrower.address, collateral);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), collateral);
    const bParams = await createBorrowOfferParams(
      collateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Borrower takes lend offer — severe negative yield triggers MEDIUM-7
    await expect(
      loanFactory.connect(borrower).takeUpLoan(borrowId, lendId)
    ).to.be.revertedWith("Post-withdrawal collateral insufficient");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MORPHO ADAPTER — zero shares/assets from MockMorphoConfigurable
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — MorphoAdapter zero shares/assets", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;
  let fakeLoanFactory: any;

  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
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
    const signers = await hre.ethers.getSigners();
    fakeLoanFactory = signers[5];

    mockMorpho = await hre.ethers.deployContract("MockMorphoConfigurable");
    await mockMorpho.waitForDeployment();

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      fakeLoanFactory.address,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

    await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await usdcMock.connect(fakeLoanFactory).approve(await morphoAdapter.getAddress(), hre.ethers.MaxUint256);
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
  });

  it("Should revert when Morpho supply returns zero shares", async function () {
    await mockMorpho.setReturnZeroShares(true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n)
    ).to.be.revertedWith("Supply returned zero shares");
  });

  it("Should revert when Morpho withdraw returns zero assets", async function () {
    // First deposit normally
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);

    // Configure zero assets return
    await mockMorpho.setReturnZeroAssets(true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, fakeLoanFactory.address)
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });

  it("Should revert when Morpho withdrawPartial returns zero assets", async function () {
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
    await mockMorpho.setReturnZeroAssets(true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdrawPartial(
        usdcAddress, 1n, hre.ethers.parseUnits("500", 6), fakeLoanFactory.address
      )
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });

  it("Should revert when Morpho emergencyWithdraw returns zero assets", async function () {
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
    await mockMorpho.setReturnZeroAssets(true);

    await expect(
      morphoAdapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, owner.address)
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });

  it("Should revert when Morpho batchEmergencyWithdraw returns zero assets per position", async function () {
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
    await mockMorpho.setReturnZeroAssets(true);

    await expect(
      morphoAdapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n], owner.address)
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTHENON VAULT ADAPTER — zero shares/assets from MockTellerConfigurable
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — ParthenonVaultAdapter zero shares/assets", function () {
  let adapter: any;
  let mockTeller: any;
  let mockAccountant: any;
  let usdcAddr: string;
  let fakeLoanFactory: any;

  beforeEach(async function () {
    const signers = await hre.ethers.getSigners();
    const deployer = signers[0];
    fakeLoanFactory = signers[5];

    const usdc = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", deployer.address, hre.ethers.parseUnits("10000000", 6), 6,
    ]);
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();

    mockTeller = await hre.ethers.deployContract("MockTellerConfigurable");
    mockAccountant = await hre.ethers.deployContract("MockAccountantConfigurable", [hre.ethers.parseUnits("1", 18)]);
    await mockTeller.waitForDeployment();
    await mockAccountant.waitForDeployment();

    const tellerAddr = await mockTeller.getAddress();
    const accountantAddr = await mockAccountant.getAddress();
    await mockTeller.setVault(tellerAddr);
    await mockTeller.setAccountant(accountantAddr);

    adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
      fakeLoanFactory.address,
    ]);
    await adapter.waitForDeployment();

    await adapter.connect(deployer).configureVault(usdcAddr, tellerAddr, tellerAddr, accountantAddr);

    await usdc.transfer(fakeLoanFactory.address, hre.ethers.parseUnits("100000", 6));
    await usdc.connect(fakeLoanFactory).approve(await adapter.getAddress(), hre.ethers.MaxUint256);
    await usdc.transfer(tellerAddr, hre.ethers.parseUnits("100000", 6));
  });

  it("Should revert when Teller bulkDeposit returns zero shares", async function () {
    await mockTeller.setReturnZeroShares(true);

    await expect(
      adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n)
    ).to.be.revertedWith("Deposit returned zero shares");
  });

  it("Should revert when Teller bulkWithdraw returns zero assets (withdraw)", async function () {
    // Deposit normally first
    await adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n);

    // Configure zero assets return
    await mockTeller.setReturnZeroAssets(true);

    await expect(
      adapter.connect(fakeLoanFactory).withdraw(usdcAddr, 1n, fakeLoanFactory.address)
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });

  it("Should revert when Teller bulkWithdraw returns zero assets (emergencyWithdraw)", async function () {
    const signers = await hre.ethers.getSigners();
    const deployer = signers[0];

    await adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n);
    await mockTeller.setReturnZeroAssets(true);

    await expect(
      adapter.connect(deployer).emergencyWithdraw(usdcAddr, 1n, deployer.address)
    ).to.be.revertedWith("Withdrawal returned zero assets");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MORPHO ADAPTER — onlyLoanFactory revert path
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — MorphoAdapter onlyLoanFactory", function () {
  let morphoAdapter: any;
  let usdcAddress: string;

  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();

    const mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      fakeLoanFactory.address,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, {
      loanToken: usdcAddress,
      collateralToken: DUMMY_ADDR,
      oracle: DUMMY_ADDR,
      irm: DUMMY_ADDR,
      lltv: 1n,
    });
  });

  it("Should revert deposit from non-LoanFactory caller", async function () {
    await expect(
      morphoAdapter.connect(owner).deposit(usdcAddress, 1000n, 1n)
    ).to.be.revertedWith("Only LoanFactory");
  });

  it("Should revert withdraw from non-LoanFactory caller", async function () {
    await expect(
      morphoAdapter.connect(owner).withdraw(usdcAddress, 1n, owner.address)
    ).to.be.revertedWith("Only LoanFactory");
  });

  it("Should revert withdrawPartial from non-LoanFactory caller", async function () {
    await expect(
      morphoAdapter.connect(owner).withdrawPartial(usdcAddress, 1n, 500n, owner.address)
    ).to.be.revertedWith("Only LoanFactory");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTHENON VAULT ADAPTER — onlyLoanFactory revert path
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — ParthenonVaultAdapter onlyLoanFactory", function () {
  let adapter: any;

  beforeEach(async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
      fakeLoanFactory.address,
    ]);
    await adapter.waitForDeployment();
  });

  it("Should revert deposit from non-LoanFactory caller", async function () {
    const signers = await hre.ethers.getSigners();
    await expect(
      adapter.connect(signers[0]).deposit(hre.ethers.ZeroAddress, 1000n, 1n)
    ).to.be.revertedWith("Only LoanFactory");
  });

  it("Should revert withdraw from non-LoanFactory caller", async function () {
    const signers = await hre.ethers.getSigners();
    await expect(
      adapter.connect(signers[0]).withdraw(hre.ethers.ZeroAddress, 1n, signers[0].address)
    ).to.be.revertedWith("Only LoanFactory");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASSET REGISTRY — onlyOwner revert path
// ═══════════════════════════════════════════════════════════════════════════

describe("Branch Gaps — AssetRegistry onlyOwner", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should revert setAssetSupported from non-owner", async function () {
    const usdcAddress = await usdcMock.getAddress();
    await expect(
      assetRegistry.connect(lender).setAssetSupported(usdcAddress, false)
    ).to.be.reverted;
  });
});
