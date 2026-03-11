/**
 * BranchCoverage.test.ts
 *
 * Targeted tests for remaining uncovered branch paths:
 *  - endLoan: excessCollateral=0 (lender gets all BTC), collateralPayout=0 edge
 *  - takeUpLoan: mild negative collateral yield (doesn't trigger revert)
 *  - takeUpLoan: negative lend yield in lender-takes-borrow path
 *  - MorphoAdapter: configureMarket blocked by active positions
 *  - MorphoAdapter: frozen market blocks withdraw
 *  - cancelLoan with id=0
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
} from "../utils/deployments";
import {
  createLoanAndGetId,
  createLendOfferParams,
  createBorrowOfferParams,
  fastForwardTime,
} from "../utils/loanHelpers";

const LEND_ASSET = hre.ethers.parseUnits("10000", 6);
const BORROW_COLLATERAL = hre.ethers.parseUnits("1", 8);
const RATE_INDEX = 0;      // 400 bps = 4%
const DURATION_INDEX = 0;  // 1 day
const INITIAL_RATIO = 15000;
const LIQ_THRESHOLD = 11000;

describe("Branch Coverage — endLoan edge cases", function () {
  let usdcAddress: string;
  let btcAddress: string;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();
  });

  async function matchLoan(): Promise<[bigint, bigint]> {
    // Fund participants
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
    return [lendId, borrowId];
  }

  it("Should handle endLoan where excessCollateral = 0 (BTC price crashed)", async function () {
    const [lendId] = await matchLoan();

    // Fast forward past maturity (1 day + buffer)
    await fastForwardTime(2);

    // Drop BTC price to $100 (from $50,000) — repayment in BTC >> collateral
    await mockAggregator.setAnswer(100n * 10n ** 8n);

    const lenderBtcBefore = await btcMock.balanceOf(lender.address);
    const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);

    await loanFactory.connect(lender).endLoan(lendId);

    const lenderBtcAfter = await btcMock.balanceOf(lender.address);
    const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);

    // Lender gets all collateral (collateralPayout = collateral, excessCollateral = 0)
    expect(lenderBtcAfter - lenderBtcBefore).to.equal(BORROW_COLLATERAL);
    // Borrower gets nothing
    expect(borrowerBtcAfter - borrowerBtcBefore).to.equal(0n);
  });

  it("Should handle endLoan where BTC price is very high — borrower gets nearly all collateral", async function () {
    const [lendId] = await matchLoan();

    // Fast forward past maturity
    await fastForwardTime(2);

    // Raise BTC to $5,000,000 — repayment in BTC is tiny
    await mockAggregator.setAnswer(5_000_000n * 10n ** 8n);

    const lenderBtcBefore = await btcMock.balanceOf(lender.address);
    const borrowerBtcBefore = await btcMock.balanceOf(borrower.address);

    await loanFactory.connect(lender).endLoan(lendId);

    const lenderBtcAfter = await btcMock.balanceOf(lender.address);
    const borrowerBtcAfter = await btcMock.balanceOf(borrower.address);

    // Lender gets very little, borrower gets nearly everything
    const lenderGot = lenderBtcAfter - lenderBtcBefore;
    const borrowerGot = borrowerBtcAfter - borrowerBtcBefore;
    expect(lenderGot + borrowerGot).to.equal(BORROW_COLLATERAL);
    expect(borrowerGot).to.be.gt(BORROW_COLLATERAL * 99n / 100n);
  });
});

describe("Branch Coverage — takeUpLoan negative yield paths", function () {
  let usdcAddress: string;
  let btcAddress: string;
  let negAdapter: any;

  beforeEach(async function () {
    await deployContracts();
    usdcAddress = await usdcMock.getAddress();
    btcAddress = await btcMock.getAddress();

    // Deploy MockYieldAdapter with mild negative yield (-1%)
    negAdapter = await hre.ethers.deployContract("MockYieldAdapter");
    await negAdapter.waitForDeployment();

    await loanFactory.connect(owner).setYieldAdapter(await negAdapter.getAddress());
    await negAdapter.setSupported(usdcAddress, true);
    await negAdapter.setSupported(btcAddress, true);

    // Fund adapter for payouts
    await usdcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("100000", 6));
    await btcMock.connect(owner).transfer(await negAdapter.getAddress(), hre.ethers.parseUnits("10", 8));
  });

  it("Should handle mild negative collateral yield in borrower-takes-lend path (no revert)", async function () {
    // -1% yield: enough collateral remains for validation
    await negAdapter.setYieldBps(9900); // 99% of deposited = -1% yield

    // Use generous collateral so -1% still passes
    const collateral = hre.ethers.parseUnits("1", 8); // 1 BTC = $50,000 >> 150% of $10,000

    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    await btcMock.connect(owner).transfer(borrower.address, collateral);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), collateral);

    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    const bParams = await createBorrowOfferParams(
      collateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Should succeed — collateral reduced by 1% but still sufficient
    await loanFactory.connect(borrower).takeUpLoan(borrowId, lendId);

    // Verify loan recorded reduced collateral (MEDIUM-5)
    const loan = await loanFactory.loans(lendId);
    const expectedCollateral = (collateral * 9900n) / 10000n;
    expect(loan.collateral).to.equal(expectedCollateral);
  });

  it("Should handle mild negative collateral yield in lender-takes-borrow path (no revert)", async function () {
    await negAdapter.setYieldBps(9900); // -1% yield

    const collateral = hre.ethers.parseUnits("1", 8);

    await usdcMock.connect(owner).transfer(lender.address, LEND_ASSET);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), LEND_ASSET);
    await btcMock.connect(owner).transfer(borrower.address, collateral);
    await btcMock.connect(borrower).approve(await loanFactory.getAddress(), collateral);

    const lParams = await createLendOfferParams(
      LEND_ASSET, RATE_INDEX, DURATION_INDEX,
      usdcAddress, btcAddress, INITIAL_RATIO, LIQ_THRESHOLD
    );
    const [lendId] = await createLoanAndGetId(lender, lParams);

    const bParams = await createBorrowOfferParams(
      collateral, RATE_INDEX, DURATION_INDEX,
      INITIAL_RATIO, LIQ_THRESHOLD, usdcAddress, btcAddress
    );
    const [borrowId] = await createLoanAndGetId(borrower, bParams);

    // Lender takes borrow offer
    await loanFactory.connect(lender).takeUpLoan(lendId, borrowId);

    // Verify loan recorded reduced collateral (MEDIUM-5 path 2)
    const loan = await loanFactory.loans(borrowId);
    const expectedCollateral = (collateral * 9900n) / 10000n;
    expect(loan.collateral).to.equal(expectedCollateral);
  });

  it("Should handle negative lend yield in lender-takes-borrow path", async function () {
    await negAdapter.setYieldBps(9500); // -5% yield

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

    const borrowerBefore = await usdcMock.balanceOf(borrower.address);

    // Lender takes borrow offer — lend yield reduced by 5%
    await loanFactory.connect(lender).takeUpLoan(lendId, borrowId);

    const borrowerAfter = await usdcMock.balanceOf(borrower.address);
    const expected = (LEND_ASSET * 9500n) / 10000n; // 9500 USDC
    expect(borrowerAfter - borrowerBefore).to.equal(expected);
  });
});

describe("Branch Coverage — MorphoAdapter configureMarket guards", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;

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

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      fakeLoanFactory.address,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

    // Fund and approve
    await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await usdcMock.connect(fakeLoanFactory).approve(await morphoAdapter.getAddress(), hre.ethers.MaxUint256);
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));

    // Deposit to create an active position
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
  });

  it("Should block configureMarket when active positions exist (MEDIUM-C6)", async function () {
    // Try to reconfigure while position is active
    const newParams = makeMarketParams(usdcAddress);
    newParams.lltv = 2n; // different params

    await expect(
      morphoAdapter.connect(owner).configureMarket(usdcAddress, newParams)
    ).to.be.revertedWith("Active positions exist for token");
  });

  it("Should allow configureMarket after all positions withdrawn", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    // Withdraw the position
    await morphoAdapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, fakeLoanFactory.address);

    // Now reconfiguration should work
    const newParams = makeMarketParams(usdcAddress);
    newParams.lltv = 2n;
    await morphoAdapter.connect(owner).configureMarket(usdcAddress, newParams);
  });
});

describe("Branch Coverage — MorphoAdapter frozen market", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;

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

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      fakeLoanFactory.address,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

    await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await usdcMock.connect(fakeLoanFactory).approve(await morphoAdapter.getAddress(), hre.ethers.MaxUint256);
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));

    // Deposit
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
  });

  it("Should block withdraw when market is frozen", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    await morphoAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, fakeLoanFactory.address)
    ).to.be.revertedWith("Market frozen");
  });

  it("Should block deposit when market is frozen", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    await morphoAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("100", 6), 2n)
    ).to.be.revertedWith("Market frozen");
  });

  it("Should block withdrawPartial when market is frozen", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    await morphoAdapter.connect(owner).setMarketFrozen(usdcAddress, true);

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdrawPartial(
        usdcAddress, 1n, hre.ethers.parseUnits("500", 6), fakeLoanFactory.address
      )
    ).to.be.revertedWith("Market frozen");
  });
});

describe("Branch Coverage — MorphoAdapter zero-recipient guards", function () {
  let mockMorpho: any;
  let morphoAdapter: any;
  let usdcAddress: string;

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

    mockMorpho = await hre.ethers.deployContract("MockMorpho");
    await mockMorpho.waitForDeployment();

    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    morphoAdapter = await hre.ethers.deployContract("MorphoAdapter", [
      await mockMorpho.getAddress(),
      fakeLoanFactory.address,
    ]);
    await morphoAdapter.waitForDeployment();

    await morphoAdapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

    await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
    await usdcMock.connect(fakeLoanFactory).approve(await morphoAdapter.getAddress(), hre.ethers.MaxUint256);
    await usdcMock.connect(owner).transfer(await mockMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));

    // Deposit
    await morphoAdapter.connect(fakeLoanFactory).deposit(usdcAddress, hre.ethers.parseUnits("1000", 6), 1n);
  });

  it("Should reject withdraw to zero address", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Recipient cannot be zero");
  });

  it("Should reject emergencyWithdraw to zero address", async function () {
    await expect(
      morphoAdapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Recipient cannot be zero");
  });

  it("Should reject withdrawPartial with zero shares", async function () {
    const signers = await hre.ethers.getSigners();
    const fakeLoanFactory = signers[5];

    await expect(
      morphoAdapter.connect(fakeLoanFactory).withdrawPartial(
        usdcAddress, 1n, 0n, fakeLoanFactory.address
      )
    ).to.be.revertedWith("Shares must be > 0");
  });
});

describe("Branch Coverage — ParthenonVaultAdapter guards", function () {
  let adapter: any;
  let mockTeller: any;
  let mockAccountant: any;
  let usdc: any;
  let owner: any;
  let fakeLoanFactory: any;
  let usdcAddr: string;

  beforeEach(async function () {
    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    fakeLoanFactory = signers[5];

    usdc = await hre.ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, hre.ethers.parseUnits("10000000", 6), 6,
    ]);
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();

    mockTeller = await hre.ethers.deployContract("MockTeller");
    mockAccountant = await hre.ethers.deployContract("MockAccountant");
    await mockTeller.waitForDeployment();
    await mockAccountant.waitForDeployment();
    await mockTeller.setVault(await mockTeller.getAddress());
    await mockTeller.setAccountant(await mockAccountant.getAddress());

    adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
      fakeLoanFactory.address,
    ]);
    await adapter.waitForDeployment();

    await adapter.connect(owner).configureVault(
      usdcAddr,
      await mockTeller.getAddress(),
      await mockTeller.getAddress(),
      await mockAccountant.getAddress(),
    );

    await usdc.transfer(fakeLoanFactory.address, hre.ethers.parseUnits("100000", 6));
    await usdc.connect(fakeLoanFactory).approve(await adapter.getAddress(), hre.ethers.MaxUint256);
    await usdc.transfer(await mockTeller.getAddress(), hre.ethers.parseUnits("100000", 6));
  });

  it("Should block configureVault when active positions exist (LOW-5)", async function () {
    // Deposit to create active position
    await adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n);

    // Try to reconfigure
    await expect(
      adapter.connect(owner).configureVault(
        usdcAddr,
        await mockTeller.getAddress(),
        await mockTeller.getAddress(),
        await mockAccountant.getAddress(),
      )
    ).to.be.revertedWith("Active positions exist for asset");
  });

  it("Should allow configureVault after all positions withdrawn", async function () {
    await adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n);
    await adapter.connect(fakeLoanFactory).withdraw(usdcAddr, 1n, fakeLoanFactory.address);

    // Reconfigure should work now
    await adapter.connect(owner).configureVault(
      usdcAddr,
      await mockTeller.getAddress(),
      await mockTeller.getAddress(),
      await mockAccountant.getAddress(),
    );
  });

  it("Should reject emergencyWithdraw to zero address", async function () {
    await adapter.connect(fakeLoanFactory).deposit(usdcAddr, hre.ethers.parseUnits("1000", 6), 1n);

    await expect(
      adapter.connect(owner).emergencyWithdraw(usdcAddr, 1n, hre.ethers.ZeroAddress)
    ).to.be.revertedWith("Recipient cannot be zero");
  });
});
