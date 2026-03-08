import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, loanFactory } from "../utils/deployments";
import { transferAndApproveToken, createLendOfferParams, createBorrowOfferParams, createLoanAndGetId } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory createLoan negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  // ── Index validation ──────────────────────────────────────────────────────

  it("Should reject invalid duration index (> 5)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    await expect(
      loanFactory.connect(lender).createLoan(
        assetAmount, 0,
        12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(),
        1, 6 // durationIndex 6 is out of bounds
      )
    ).to.be.revertedWith("Invalid duration index");
  });

  it("Should reject invalid rate index (> 7)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    await expect(
      loanFactory.connect(lender).createLoan(
        assetAmount, 0,
        12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(),
        8, 1 // rateIndex 8 is out of bounds
      )
    ).to.be.revertedWith("Invalid interest rate index");
  });

  // ── Liquidation threshold bounds ─────────────────────────────────────────

  it("Should reject liquidation threshold below minimum (< 10000)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const params = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      11000, 9999 // below 10000 minimum
    );
    await expect(createLoanAndGetId(lender, params)).to.be.revertedWith("Invalid liquidation threshold");
  });

  it("Should reject liquidation threshold above maximum (> 15000)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const params = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      50000, 15001 // above 15000 maximum
    );
    await expect(createLoanAndGetId(lender, params)).to.be.revertedWith("Invalid liquidation threshold");
  });

  // ── Initial collateral ratio bounds ──────────────────────────────────────

  it("Should reject initial collateral ratio below minimum (< 11000)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const params = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      10999, 10000 // initialCollateralRatio 10999 < 11000 minimum
    );
    await expect(createLoanAndGetId(lender, params)).to.be.revertedWith("Invalid initial collateral ratio");
  });

  it("Should reject initial collateral ratio above maximum (> 50000)", async function () {
    const assetAmount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), assetAmount, "USDC");
    const params = await createLendOfferParams(
      assetAmount, 1, 1,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      50001, 10000 // initialCollateralRatio 50001 > 50000 maximum
    );
    await expect(createLoanAndGetId(lender, params)).to.be.revertedWith("Invalid initial collateral ratio");
  });

  // ── Offer parameter validation ────────────────────────────────────────────

  it("Should reject when both asset and collateral are set", async function () {
    const amount = hre.ethers.parseUnits("1000", 6);
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), amount, "USDC");
    await expect(
      loanFactory.connect(lender).createLoan(
        amount, amount, // both non-zero
        12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(),
        1, 1
      )
    ).to.be.revertedWith("Invalid offer parameters");
  });

  it("Should reject when both asset and collateral are zero", async function () {
    await expect(
      loanFactory.connect(lender).createLoan(
        0, 0, // both zero
        12000, 11000,
        await usdcMock.getAddress(), await btcMock.getAddress(),
        1, 1
      )
    ).to.be.revertedWith("Invalid offer parameters");
  });

  // ── Borrow offer: collateral value floor ─────────────────────────────────

  it("Should reject borrow offer with collateral value below $100", async function () {
    // 0.000001 BTC at $50k = $0.05 — below $100 minimum
    const tinyCollateral = hre.ethers.parseUnits("0.000001", 8);
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), tinyCollateral, "BTC");
    const params = await createBorrowOfferParams(
      tinyCollateral, 1, 1, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await expect(createLoanAndGetId(borrower, params)).to.be.revertedWith("Collateral value too low");
  });
});
