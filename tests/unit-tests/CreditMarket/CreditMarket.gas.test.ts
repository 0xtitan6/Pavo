import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";
import { LoanPositionToken } from "../../../typechain-types/contracts/module2/LoanPositionToken.sol/LoanPositionToken";

describe("CreditMarket gas profiling", function () {
  const GAS_LIMITS = {
    authorizeBorrower: 100000,
    createMarket: 3600000,
    registerLender: 55000,
    depositFirst: 200000,
    depositSubsequent: 150000,
    borrow: 200000,
    repay: 150000,
    accrueInterestNormal: 100000,
    accrueInterestDelinquent: 150000,
    requestWithdrawal: 150000,
    processWithdrawalBatch: 200000,
    claimWithdrawal: 100000,
    transfer: 80000,
  };

  async function deployFullFixture() {
    const [owner, borrower, lender, lender2, user3] = await ethers.getSigners();

    const asset = await ethers.deployContract("ERC20Mock", [
      "USD Coin", "USDC", owner.address, ethers.parseUnits("10000000", 6), 6
    ]);

    const orchestrator = await ethers.deployContract("Orchestrator", [owner.address]);
    await orchestrator.authorizeBorrower(borrower.address, 3);

    const params: CreditTypesLib.MarketParametersStruct = {
      annualInterestBips: 500,
      delinquencyFeeBips: 200,
      withdrawalBatchDuration: 604800,
      reserveRatioBips: 1000,
      delinquencyGracePeriod: 259200,
      protocolFeeBips: 100,
      maxDelinquencyPeriod: 2592000,
      maxTotalSupply: ethers.parseUnits("10000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    await asset.transfer(lender.address, ethers.parseUnits("1000000", 6));
    await asset.transfer(lender2.address, ethers.parseUnits("1000000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await asset.connect(lender2).approve(marketAddress, ethers.MaxUint256);

    const lptAddress = await market.positionToken();
    const lpt = await ethers.getContractAt("LoanPositionToken", lptAddress);

    return { market, marketAddress, lpt, asset, orchestrator, owner, borrower, lender, lender2, user3, params };
  }

  describe("Gas profiling", function () {
    it("1. authorizeBorrower gas", async function () {
      const { orchestrator } = await loadFixture(deployFullFixture);
      const borrower = (await ethers.getSigners())[10];
      const tx = await orchestrator.authorizeBorrower(borrower.address, 2);
      const receipt = await tx.wait();
      console.log(`authorizeBorrower: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.authorizeBorrower);
    });

    it("2. createMarket gas", async function () {
      const { orchestrator, asset, params } = await loadFixture(deployFullFixture);
      const borrower = (await ethers.getSigners())[11];
      await orchestrator.authorizeBorrower(borrower.address, 3);
      const tx = await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
      const receipt = await tx.wait();
      console.log(`createMarket: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.createMarket);
    });

    it("3. registerLender gas", async function () {
      const { orchestrator, marketAddress } = await loadFixture(deployFullFixture);
      const newLender = (await ethers.getSigners())[12];
      const tx = await orchestrator.registerLender(marketAddress, newLender.address);
      const receipt = await tx.wait();
      console.log(`registerLender: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.registerLender);
    });

    it("4. deposit (first) gas", async function () {
      const { market, lender } = await loadFixture(deployFullFixture);
      const amount = ethers.parseUnits("10000", 6);
      const tx = await market.connect(lender).deposit(amount, lender.address);
      const receipt = await tx.wait();
      console.log(`deposit (first): ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.depositFirst);
    });

    it("5. deposit (subsequent) gas", async function () {
      const { market, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      const amount = ethers.parseUnits("5000", 6);
      const tx = await market.connect(lender).deposit(amount, lender.address);
      const receipt = await tx.wait();
      console.log(`deposit (subsequent): ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.depositSubsequent);
    });

    it("6. borrow gas", async function () {
      const { market, borrower, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
      const amount = ethers.parseUnits("5000", 6);
      const tx = await market.connect(borrower).borrow(amount);
      const receipt = await tx.wait();
      console.log(`borrow: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.borrow);
    });

    it("7. repay gas", async function () {
      const { market, borrower, lender, asset } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
      await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));
      await asset.connect(borrower).approve(await market.getAddress(), ethers.MaxUint256);
      const amount = ethers.parseUnits("1000", 6);
      const tx = await market.connect(borrower).repay(amount);
      const receipt = await tx.wait();
      console.log(`repay: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.repay);
    });

    it("8. accrueInterest (normal) gas", async function () {
      const { market, borrower, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
      await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));
      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine", []);
      const tx = await market.accrueInterest();
      const receipt = await tx.wait();
      console.log(`accrueInterest (normal): ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.accrueInterestNormal);
    });

    it("9. accrueInterest (delinquent) gas", async function () {
      const { market, borrower, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("100000", 6), lender.address);
      await market.connect(borrower).borrow(ethers.parseUnits("5000", 6));
      await ethers.provider.send("evm_increaseTime", [300000]);
      await ethers.provider.send("evm_mine", []);
      const tx = await market.accrueInterest();
      const receipt = await tx.wait();
      console.log(`accrueInterest (delinquent): ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.accrueInterestDelinquent);
    });

    it("10. requestWithdrawal gas", async function () {
      const { market, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      const amount = ethers.parseUnits("5000", 6);
      const tx = await market.connect(lender).requestWithdrawal(amount);
      const receipt = await tx.wait();
      console.log(`requestWithdrawal: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.requestWithdrawal);
    });

    it("11. processWithdrawalBatch gas", async function () {
      const { market, lender } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("5000", 6));
      await ethers.provider.send("evm_increaseTime", [604800]);
      await ethers.provider.send("evm_mine", []);
      const tx = await market.processWithdrawalBatch();
      const receipt = await tx.wait();
      console.log(`processWithdrawalBatch: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.processWithdrawalBatch);
    });

    it("12. claimWithdrawal gas", async function () {
      const { market, lender, asset } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      await market.connect(lender).requestWithdrawal(ethers.parseUnits("5000", 6));
      // Get the batch expiry from state before advancing time
      const state = await market.getState();
      const batchExpiry = state.pendingWithdrawalExpiry;
      await ethers.provider.send("evm_increaseTime", [604800]);
      await ethers.provider.send("evm_mine", []);
      await market.processWithdrawalBatch();
      const tx = await market.connect(lender).claimWithdrawal(batchExpiry);
      const receipt = await tx.wait();
      console.log(`claimWithdrawal: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.claimWithdrawal);
    });

    it("13. LoanPositionToken.transfer gas", async function () {
      const { market, lpt, lender, lender2 } = await loadFixture(deployFullFixture);
      await market.connect(lender).deposit(ethers.parseUnits("10000", 6), lender.address);
      const balance = await lpt.balanceOf(lender.address);
      const tx = await lpt.connect(lender).transfer(lender2.address, balance);
      const receipt = await tx.wait();
      console.log(`transfer: ${receipt?.gasUsed} gas`);
      expect(receipt?.gasUsed).to.lt(GAS_LIMITS.transfer);
    });
  });
});
