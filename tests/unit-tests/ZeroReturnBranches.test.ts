import hre from "hardhat";
import { expect } from "chai";
import {
  deployContracts,
  owner,
  lender,
  borrower,
  usdcMock,
  btcMock,
} from "../utils/deployments";

/**
 * Tests for uncovered branches where external calls return zero shares/assets.
 * These hit the `require(shares > 0)` and `require(assets > 0)` guards
 * in MorphoAdapter and ParthenonVaultAdapter.
 */
describe("Zero-Return Branch Coverage", function () {
  const DUMMY_ADDR = "0x0000000000000000000000000000000000000001";
  const makeMarketParams = (loanToken: string) => ({
    loanToken,
    collateralToken: DUMMY_ADDR,
    oracle: DUMMY_ADDR,
    irm: DUMMY_ADDR,
    lltv: 1n,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MorphoAdapter: zero shares on supply, zero assets on withdraw
  // ═══════════════════════════════════════════════════════════════════════
  describe("MorphoAdapter — zero return guards", function () {
    let configurableMorpho: any;
    let adapter: any;
    let fakeLoanFactory: any;
    let usdcAddress: string;

    beforeEach(async function () {
      await deployContracts();
      usdcAddress = await usdcMock.getAddress();

      const signers = await hre.ethers.getSigners();
      fakeLoanFactory = signers[5];

      configurableMorpho = await hre.ethers.deployContract("MockMorphoConfigurable");
      await configurableMorpho.waitForDeployment();

      adapter = await hre.ethers.deployContract("MorphoAdapter", [
        await configurableMorpho.getAddress(),
        fakeLoanFactory.address,
      ]);
      await adapter.waitForDeployment();

      await adapter.connect(owner).configureMarket(usdcAddress, makeMarketParams(usdcAddress));

      // Fund fakeLoanFactory and approve adapter
      await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(fakeLoanFactory).approve(await adapter.getAddress(), hre.ethers.MaxUint256);

      // Fund configurableMorpho for withdraw yield
      await usdcMock.connect(owner).transfer(await configurableMorpho.getAddress(), hre.ethers.parseUnits("10000", 6));
    });

    it("deposit reverts when Morpho supply returns zero shares", async function () {
      await configurableMorpho.setReturnZeroShares(true);
      const amount = hre.ethers.parseUnits("1000", 6);
      await expect(
        adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n)
      ).to.be.revertedWith("Supply returned zero shares");
    });

    it("withdraw reverts when Morpho withdraw returns zero assets", async function () {
      // First deposit normally
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      // Now configure to return zero assets
      await configurableMorpho.setReturnZeroAssets(true);
      await expect(
        adapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, fakeLoanFactory.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });

    it("withdrawPartial reverts when Morpho withdraw returns zero assets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      const shares = await adapter.sharesOf(1n, usdcAddress);
      const halfShares = shares / 2n;

      await configurableMorpho.setReturnZeroAssets(true);
      await expect(
        adapter.connect(fakeLoanFactory).withdrawPartial(usdcAddress, 1n, halfShares, fakeLoanFactory.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });

    it("emergencyWithdraw reverts when Morpho withdraw returns zero assets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      await configurableMorpho.setReturnZeroAssets(true);
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, owner.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });

    it("batchEmergencyWithdraw reverts when Morpho withdraw returns zero assets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      await configurableMorpho.setReturnZeroAssets(true);
      await expect(
        adapter.connect(owner).batchEmergencyWithdraw(usdcAddress, [1n], owner.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ParthenonVaultAdapter: zero shares on deposit, zero assets on withdraw
  // ═══════════════════════════════════════════════════════════════════════
  describe("ParthenonVaultAdapter — zero return guards", function () {
    let configurableTeller: any;
    let accountant: any;
    let adapter: any;
    let fakeLoanFactory: any;
    let usdcAddress: string;

    beforeEach(async function () {
      await deployContracts();
      usdcAddress = await usdcMock.getAddress();

      const signers = await hre.ethers.getSigners();
      fakeLoanFactory = signers[5];

      // Deploy a real MockAccountant (rate=1e18) and configurable teller
      accountant = await hre.ethers.deployContract("MockAccountant");
      await accountant.waitForDeployment();

      configurableTeller = await hre.ethers.deployContract("MockTellerConfigurable");
      await configurableTeller.waitForDeployment();

      // Use a dummy address as vault — ParthenonVaultAdapter never calls vault directly
      const dummyVault = "0x0000000000000000000000000000000000000002";

      // Set up cross-validation
      await configurableTeller.setVault(dummyVault);
      await configurableTeller.setAccountant(await accountant.getAddress());

      adapter = await hre.ethers.deployContract("ParthenonVaultAdapter", [
        fakeLoanFactory.address,
      ]);
      await adapter.waitForDeployment();

      await adapter.connect(owner).configureVault(
        usdcAddress,
        dummyVault,
        await configurableTeller.getAddress(),
        await accountant.getAddress()
      );

      // Fund fakeLoanFactory and approve adapter
      await usdcMock.connect(owner).transfer(fakeLoanFactory.address, hre.ethers.parseUnits("50000", 6));
      await usdcMock.connect(fakeLoanFactory).approve(await adapter.getAddress(), hre.ethers.MaxUint256);

      // Fund teller for withdraw yield
      await usdcMock.connect(owner).transfer(await configurableTeller.getAddress(), hre.ethers.parseUnits("10000", 6));
    });

    it("deposit reverts when Teller bulkDeposit returns zero shares", async function () {
      await configurableTeller.setReturnZeroShares(true);
      const amount = hre.ethers.parseUnits("1000", 6);
      await expect(
        adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n)
      ).to.be.revertedWith("Deposit returned zero shares");
    });

    it("withdraw reverts when Teller bulkWithdraw returns zero assets", async function () {
      // First deposit normally
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      // Now configure to return zero assets
      await configurableTeller.setReturnZeroAssets(true);
      await expect(
        adapter.connect(fakeLoanFactory).withdraw(usdcAddress, 1n, fakeLoanFactory.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });

    it("emergencyWithdraw reverts when Teller bulkWithdraw returns zero assets", async function () {
      const amount = hre.ethers.parseUnits("1000", 6);
      await adapter.connect(fakeLoanFactory).deposit(usdcAddress, amount, 1n);

      await configurableTeller.setReturnZeroAssets(true);
      await expect(
        adapter.connect(owner).emergencyWithdraw(usdcAddress, 1n, owner.address)
      ).to.be.revertedWith("Withdrawal returned zero assets");
    });
  });
});
