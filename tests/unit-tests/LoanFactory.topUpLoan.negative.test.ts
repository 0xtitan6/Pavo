import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory } from "../utils/deployments";
import { transferAndApproveToken, createLoanAndGetId, createLendOfferParams, createBorrowOfferParams } from "../utils/loanHelpers";
import hre from "hardhat";

describe("LoanFactory topUp negative tests", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  async function createActiveLoan(): Promise<bigint> {
    const collateralAmount = hre.ethers.parseUnits("1.102", 8);
    const loanAmount = hre.ethers.parseUnits("25000", 6);

    const borrowParams = await createBorrowOfferParams(
      collateralAmount, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const lendParams = await createLendOfferParams(
      loanAmount, 1, 2,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      12000, 11000
    );
    await transferAndApproveToken(usdcMock, lender, await loanFactory.getAddress(), loanAmount, "USDC");
    const [lendOfferId] = await createLoanAndGetId(lender, lendParams);

    await loanFactory.connect(borrower).takeUpLoan(borrowOfferId, lendOfferId);
    return lendOfferId;
  }

  it("Should reject topUp with zero additional collateral", async function () {
    const lendOfferId = await createActiveLoan();

    await expect(loanFactory.connect(borrower).topUp(lendOfferId, 0))
      .to.be.revertedWith("Additional collateral must be > 0");
  });

  it("Should reject topUp by lender (not borrower)", async function () {
    const lendOfferId = await createActiveLoan();
    const topUpAmount = hre.ethers.parseUnits("0.1", 8);

    await transferAndApproveToken(btcMock, lender, await loanFactory.getAddress(), topUpAmount, "BTC");

    await expect(loanFactory.connect(lender).topUp(lendOfferId, topUpAmount))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject topUp by a third party (owner)", async function () {
    const lendOfferId = await createActiveLoan();
    const topUpAmount = hre.ethers.parseUnits("0.1", 8);

    await transferAndApproveToken(btcMock, owner, await loanFactory.getAddress(), topUpAmount, "BTC");

    await expect(loanFactory.connect(owner).topUp(lendOfferId, topUpAmount))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject topUp on nonexistent loan", async function () {
    await expect(loanFactory.connect(borrower).topUp(999, hre.ethers.parseUnits("0.1", 8)))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject topUp on a borrow offer (not yet active, s2)", async function () {
    const collateralAmount = hre.ethers.parseUnits("1.102", 8);
    const borrowParams = await createBorrowOfferParams(
      collateralAmount, 1, 2, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress()
    );
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), collateralAmount, "BTC");
    const [borrowOfferId] = await createLoanAndGetId(borrower, borrowParams);

    const topUpAmount = hre.ethers.parseUnits("0.1", 8);
    await transferAndApproveToken(btcMock, borrower, await loanFactory.getAddress(), topUpAmount, "BTC");

    await expect(loanFactory.connect(borrower).topUp(borrowOfferId, topUpAmount))
      .to.be.revertedWith("Loan not found, inactive, or unauthorized");
  });

  it("Should reject topUp when borrower has no BTC approval", async function () {
    const lendOfferId = await createActiveLoan();
    const topUpAmount = hre.ethers.parseUnits("0.1", 8);

    // Borrower has BTC but hasn't approved the contract
    await btcMock.transfer(borrower.address, topUpAmount);
    // No approve call

    await expect(loanFactory.connect(borrower).topUp(lendOfferId, topUpAmount))
      .to.be.reverted; // ERC20 insufficient allowance
  });
});
