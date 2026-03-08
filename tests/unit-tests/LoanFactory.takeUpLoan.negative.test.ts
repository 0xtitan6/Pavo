import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory, mockAggregator } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory takeUpLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  async function makeBorrowOffer(collateralAmount: bigint) {
    const params = await createBorrowOfferParams(
      collateralAmount, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [id] = await createLoanAndGetId(borrower, params);
    return id;
  }

  async function makeLendOffer(assetAmount: bigint) {
    const params = await createLendOfferParams(
      assetAmount, 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const [id] = await createLoanAndGetId(lender, params);
    return id;
  }

  it("Should reject when caller is neither lender nor borrower of takeUpId", async function () {
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));

    // owner is a third party — not the borrower of borrowOfferId
    await expect(loanFactory.connect(owner).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.revertedWith("Unauthorized caller");
  });

  it("Should reject when borrower's collateral is insufficient for lend offer size", async function () {
    // Tiny collateral: 0.01 BTC at $50k = $500 < 120% of $10,000 = $12,000
    const tinyCollateral = hre.ethers.parseUnits("0.01", 8);
    const bigLoan = hre.ethers.parseUnits("10000", 6);

    const borrowOfferId = await makeBorrowOffer(tinyCollateral);
    const lendOfferId = await makeLendOffer(bigLoan);

    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.revertedWith("Collateral insufficient: phi(z) must be > max(rho*v, c*v)");
  });

  it("Should reject when borrower tries to take up own lend offer (same address)", async function () {
    // borrower creates both a borrow offer AND a lend offer — should not be able to match with self
    const borrowParams = await createBorrowOfferParams(
      hre.ethers.parseUnits("1.102", 8), 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), hre.ethers.parseUnits("1.102", 8), "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendParams = await createLendOfferParams(
      hre.ethers.parseUnits("25000", 6), 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, borrower, await loanFactory.getAddress(), hre.ethers.parseUnits("25000", 6), "USDC");
    const [lendOfferId] = await createLoanAndGetId(borrower, lendParams);

    // The guard: loans[takeUpId].borrower != loans[offerId].lender prevents self-match
    // The condition fails — falls through to "Unauthorized caller"
    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.revertedWith("Unauthorized caller");
  });

  it("Should reject takeUp of already-active loan (lend offer already matched)", async function () {
    const borrowOfferId1 = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const borrowOfferId2 = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));

    // First takeUp succeeds
    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId1, lendOfferId);

    // Second borrower tries to take the same (now-active) lend offer
    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId2, lendOfferId))
      .to.be.revertedWith("Invalid: borrowOffer must be s2 and lendOffer must be s1");
  });

  it("Should reject lender taking up a lend offer (wrong direction)", async function () {
    const lendOfferId1 = await makeLendOffer(hre.ethers.parseUnits("25000", 6));
    const lendOfferId2 = await makeLendOffer(hre.ethers.parseUnits("25000", 6));

    // lender tries to take their own lend offer against another lend offer
    await expect(loanFactory.connect(lender).takeUpLoan(lendOfferId1, lendOfferId2))
      .to.be.revertedWith("Invalid: lendOffer must be s1 and borrowOffer must be s2");
  });

  it("Should reject takeUp with collateral value exactly at (not above) required ratio", async function () {
    // 1 BTC at $50k = $50,000. 120% of $50,000 = $60,000. Collateral $50,000 is NOT > $60,000.
    const collateral = hre.ethers.parseUnits("1", 8); // $50,000
    const loanAmount = hre.ethers.parseUnits("50000", 6); // 120% required = $60,000

    const borrowParams = await createBorrowOfferParams(
      collateral, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateral, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendParams = await createLendOfferParams(
      loanAmount, 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAmount, "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.revertedWith("Collateral insufficient: phi(z) must be > max(rho*v, c*v)");
  });

  it("Should reject takeUpLoan when takeUpId == offerId (self-match aliasing)", async function () {
    const lendOfferId = await makeLendOffer(hre.ethers.parseUnits("25000", 6));

    await expect(loanFactory.connect(lender).takeUpLoan(lendOfferId, lendOfferId))
      .to.be.revertedWith("IDs must differ");
  });

  // ── H-2: circuit breaker must not block takeUpLoan ────────────────────────

  it("H-2: Should allow takeUpLoan even when BTC price has crashed >50% (unchecked oracle)", async function () {
    // Lend offer: $15,000. At the crashed price $20k: 1.102 BTC = $22,040 > 120% * $15k = $18k ✓
    // This ensures collateral is still sufficient after the crash so the match should succeed.
    const borrowOfferId = await makeBorrowOffer(hre.ethers.parseUnits("1.102", 8));

    // Create lend offer at $15,000 — valid at original $50k price
    const lendParams = await createLendOfferParams(
      hre.ethers.parseUnits("15000", 6), 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(), 12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), hre.ethers.parseUnits("15000", 6), "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    // Crash BTC price 60% → $20,000 (circuit breaker triggers at 50% deviation from $50k)
    // A checked oracle call would revert with PriceDeviationTooLarge
    const crashedPrice = 20_000n * 10n ** 8n;
    await mockAggregator.setAnswer(crashedPrice);

    // takeUpLoan must succeed because it uses the unchecked oracle path (H-2 fix)
    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.not.be.reverted;
  });

  // ── M-6: cross-pair validation ────────────────────────────────────────────

  it("M-6: Should reject takeUpLoan when asset addresses differ between offers", async function () {
    // Deploy a second "asset" token (reuse btcMock as a stand-in for a different token)
    // We create a borrow offer with usdcMock as collateralAddress but a different assetAddress
    // Simplest approach: create offers manually with mismatched addresses via loanFactory directly

    // Register btcMock as both collateral and asset so we can create a mismatched offer
    // Instead, deploy a fresh ERC20 to use as a second asset
    const asset2 = await hre.ethers.deployContract("ERC20Mock", [
      "Token2", "TK2", owner.address, hre.ethers.parseUnits("1000000", 6), 6
    ]);
    await asset2.waitForDeployment();

    // Register asset2 and set pair (btcMock collateral, asset2 asset)
    const assetRegistry = await hre.ethers.getContractAt("AssetRegistry", await loanFactory.assetRegistry());
    await assetRegistry.registerAsset(await asset2.getAddress(), "TK2", "", 6);
    await assetRegistry.setAssetSupported(await asset2.getAddress(), true);
    await assetRegistry.setPairSupported(await btcMock.getAddress(), await asset2.getAddress(), true);

    // Lend offer: asset=usdcMock, collateral=btcMock
    const lendParams = await createLendOfferParams(
      hre.ethers.parseUnits("25000", 6), 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(), 12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), hre.ethers.parseUnits("25000", 6), "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    // Borrow offer: asset=asset2 (different!), collateral=btcMock
    const borrowParams = await createBorrowOfferParams(
      hre.ethers.parseUnits("1.102", 8), 1, 2, 12000, 11000,
      await asset2.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), hre.ethers.parseUnits("1.102", 8), "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    // takeUpLoan should revert — asset addresses differ
    await expect(loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId))
      .to.be.revertedWith("Offers must use the same asset token");
  });
});
