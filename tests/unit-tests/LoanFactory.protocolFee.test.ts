import { expect } from "chai";
import hre from "hardhat";
import { deployContracts, usdcMock, btcMock, lender, borrower, owner, loanFactory, priceOracle, assetRegistry } from "../utils/deployments";
// loanHelpers not needed — using explicit createLoan calls

describe("LoanFactory protocol fee tests", function () {
  let feeRecipient: any;
  let loanFactoryWithFee: any;

  beforeEach(async function () {
    await deployContracts();
    // feeRecipient is a fresh signer distinct from owner/lender/borrower
    [, , , feeRecipient] = await hre.ethers.getSigners();

    // Deploy a separate LoanFactory instance with 0.30% fee (30 bps)
    loanFactoryWithFee = await hre.ethers.deployContract("LoanFactory", [
      await priceOracle.getAddress(),
      await assetRegistry.getAddress(),
      feeRecipient.address,
      30 // 0.30%
    ]);
    await loanFactoryWithFee.waitForDeployment();
  });

  // ── Constructor / admin ──

  it("Should initialise with correct fee params", async function () {
    expect(await loanFactoryWithFee.protocolFeeBps()).to.equal(30);
    expect(await loanFactoryWithFee.feeRecipient()).to.equal(feeRecipient.address);
  });

  it("Should allow owner to update fee", async function () {
    await loanFactoryWithFee.connect(owner).setProtocolFee(50);
    expect(await loanFactoryWithFee.protocolFeeBps()).to.equal(50);
  });

  it("Should reject fee update above 500 bps", async function () {
    await expect(loanFactoryWithFee.connect(owner).setProtocolFee(501))
      .to.be.revertedWith("Fee exceeds maximum");
  });

  it("Should reject fee update from non-owner", async function () {
    await expect(loanFactoryWithFee.connect(lender).setProtocolFee(10))
      .to.be.reverted; // OwnableUnauthorizedAccount
  });

  it("Should allow owner to update feeRecipient", async function () {
    await loanFactoryWithFee.connect(owner).setFeeRecipient(lender.address);
    expect(await loanFactoryWithFee.feeRecipient()).to.equal(lender.address);
  });

  it("Should allow zero address as feeRecipient (disables fee collection)", async function () {
    await expect(loanFactoryWithFee.connect(owner).setFeeRecipient(hre.ethers.ZeroAddress))
      .to.not.be.reverted;
    expect(await loanFactoryWithFee.feeRecipient()).to.equal(hre.ethers.ZeroAddress);
  });

  it("Should reject feeRecipient update from non-owner", async function () {
    await expect(loanFactoryWithFee.connect(borrower).setFeeRecipient(borrower.address))
      .to.be.reverted;
  });

  it("Should reject constructor with fee above maximum", async function () {
    await expect(
      hre.ethers.deployContract("LoanFactory", [
        await priceOracle.getAddress(),
        await assetRegistry.getAddress(),
        feeRecipient.address,
        501 // 5.01% — above max
      ])
    ).to.be.revertedWith("Fee exceeds maximum");
  });

  // Helper: call createLoan with explicit arg order matching contract ABI
  // createLoan(_asset, _collateral, _initialCollateralRatio, _liquidationThreshold,
  //            _assetAddress, _collateralAddress, _rateIndex, _durationIndex)
  async function callCreateLend(factory: any, caller: any, assetAmount: bigint) {
    return factory.connect(caller).createLoan(
      assetAmount, 0n, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      1, 2
    );
  }

  async function callCreateBorrow(factory: any, caller: any, collateralAmount: bigint) {
    return factory.connect(caller).createLoan(
      0n, collateralAmount, 12000, 11000,
      await usdcMock.getAddress(), await btcMock.getAddress(),
      1, 2
    );
  }

  // ── Fee collection on lend offer ──

  it("Should collect fee from USDC on lend offer creation", async function () {
    const loanAmount = hre.ethers.parseUnits("25000", 6);
    const expectedFee = (loanAmount * 30n) / 10000n;
    const netAmount = loanAmount - expectedFee;

    await usdcMock.connect(owner).transfer(lender.address, loanAmount);
    await usdcMock.connect(lender).approve(await loanFactoryWithFee.getAddress(), loanAmount);

    const recipientBefore = await usdcMock.balanceOf(feeRecipient.address);

    const tx = await callCreateLend(loanFactoryWithFee, lender, loanAmount);
    const receipt = await tx.wait();

    // Check FeeCollected event
    const feeEvent = receipt.logs
      .map((log: any) => { try { return loanFactoryWithFee.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e?.name === "FeeCollected");
    expect(feeEvent).to.not.be.null;
    expect(feeEvent.args.amount).to.equal(expectedFee);

    // feeRecipient received the fee
    expect(await usdcMock.balanceOf(feeRecipient.address)).to.equal(recipientBefore + expectedFee);
    // Contract holds only the net amount
    expect(await usdcMock.balanceOf(await loanFactoryWithFee.getAddress())).to.equal(netAmount);
  });

  it("Should collect fee from BTC on borrow offer creation", async function () {
    const collateralAmount = hre.ethers.parseUnits("1.102", 8);
    const expectedFee = (collateralAmount * 30n) / 10000n;
    const netAmount = collateralAmount - expectedFee;

    await btcMock.connect(owner).transfer(borrower.address, collateralAmount);
    await btcMock.connect(borrower).approve(await loanFactoryWithFee.getAddress(), collateralAmount);

    const recipientBefore = await btcMock.balanceOf(feeRecipient.address);

    const tx = await callCreateBorrow(loanFactoryWithFee, borrower, collateralAmount);
    const receipt = await tx.wait();

    const feeEvent = receipt.logs
      .map((log: any) => { try { return loanFactoryWithFee.interface.parseLog(log); } catch { return null; } })
      .find((e: any) => e?.name === "FeeCollected");
    expect(feeEvent).to.not.be.null;
    expect(feeEvent.args.amount).to.equal(expectedFee);

    expect(await btcMock.balanceOf(feeRecipient.address)).to.equal(recipientBefore + expectedFee);
    expect(await btcMock.balanceOf(await loanFactoryWithFee.getAddress())).to.equal(netAmount);
  });

  // ── Zero fee / disabled fee ──

  it("Should not collect fee when protocolFeeBps is 0", async function () {
    const loanAmount = hre.ethers.parseUnits("1000", 6);
    await usdcMock.connect(owner).transfer(lender.address, loanAmount);
    await usdcMock.connect(lender).approve(await loanFactory.getAddress(), loanAmount);

    const contractBefore = await usdcMock.balanceOf(await loanFactory.getAddress());
    await callCreateLend(loanFactory, lender, loanAmount);

    // Full amount held — no fee deducted
    expect(await usdcMock.balanceOf(await loanFactory.getAddress())).to.equal(contractBefore + loanAmount);
  });

  it("Should not collect fee when feeRecipient is zero address", async function () {
    const noRecipientFactory = await hre.ethers.deployContract("LoanFactory", [
      await priceOracle.getAddress(),
      await assetRegistry.getAddress(),
      hre.ethers.ZeroAddress, // no recipient — disables fee even though bps > 0
      30
    ]);
    await noRecipientFactory.waitForDeployment();

    const loanAmount = hre.ethers.parseUnits("1000", 6);
    await usdcMock.connect(owner).transfer(lender.address, loanAmount);
    await usdcMock.connect(lender).approve(await noRecipientFactory.getAddress(), loanAmount);

    const contractBefore = await usdcMock.balanceOf(await noRecipientFactory.getAddress());
    await callCreateLend(noRecipientFactory, lender, loanAmount);

    // Full amount stored — no fee since recipient is zero
    expect(await usdcMock.balanceOf(await noRecipientFactory.getAddress())).to.equal(contractBefore + loanAmount);
  });

  // ── Fee math edge cases ──

  it("Should correctly compute fee with maximum fee rate (500 bps)", async function () {
    const maxFeeFactory = await hre.ethers.deployContract("LoanFactory", [
      await priceOracle.getAddress(),
      await assetRegistry.getAddress(),
      feeRecipient.address,
      500 // 5%
    ]);
    await maxFeeFactory.waitForDeployment();

    const loanAmount = hre.ethers.parseUnits("10000", 6);
    const expectedFee = (loanAmount * 500n) / 10000n; // 500 USDC
    const netAmount = loanAmount - expectedFee;

    await usdcMock.connect(owner).transfer(lender.address, loanAmount);
    await usdcMock.connect(lender).approve(await maxFeeFactory.getAddress(), loanAmount);

    await callCreateLend(maxFeeFactory, lender, loanAmount);

    expect(await usdcMock.balanceOf(feeRecipient.address)).to.equal(expectedFee);
    expect(await usdcMock.balanceOf(await maxFeeFactory.getAddress())).to.equal(netAmount);
  });
});
