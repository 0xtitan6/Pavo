import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CreditTypesLib } from "../../../typechain-types/contracts/module2/libraries/CreditTypesLib.sol/CreditTypesLib";

describe("LoanPositionToken tests", function () {
  async function deployLPTFixture() {
    const [owner, borrower, lender, lender2, nonLender] = await ethers.getSigners();

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
      maxTotalSupply: ethers.parseUnits("1000000", 6),
      maturityDate: 0,
      gmslaRefHash: ethers.ZeroHash,
      collateralRatioBps: 0
    };

    const marketAddress = await orchestrator.createMarket.staticCall(borrower.address, await asset.getAddress(), params);
    await orchestrator.createMarket(borrower.address, await asset.getAddress(), params);
    const market = await ethers.getContractAt("CreditMarket", marketAddress);

    await orchestrator.registerLender(marketAddress, lender.address);
    await orchestrator.registerLender(marketAddress, lender2.address);

    await asset.transfer(lender.address, ethers.parseUnits("100000", 6));
    await asset.connect(lender).approve(marketAddress, ethers.MaxUint256);
    await market.connect(lender).deposit(ethers.parseUnits("50000", 6), lender.address);

    const positionToken = await ethers.getContractAt("LoanPositionToken", await market.positionToken());

    return {
      market, marketAddress, asset, orchestrator, owner,
      borrower, lender, lender2, nonLender, positionToken
    };
  }

  describe("basic properties", function () {
    it("Should have correct market address", async function () {
      const { positionToken, marketAddress } = await loadFixture(deployLPTFixture);
      expect(await positionToken.market()).to.equal(marketAddress);
    });

    it("Should have correct orchestrator address", async function () {
      const { positionToken, orchestrator } = await loadFixture(deployLPTFixture);
      expect(await positionToken.orchestratorAddr()).to.equal(await orchestrator.getAddress());
    });

    it("Should return non-zero scaleFactor", async function () {
      const { positionToken } = await loadFixture(deployLPTFixture);
      const sf = await positionToken.scaleFactor();
      expect(sf).to.be.gt(0);
    });
  });

  describe("normalizedBalanceOf", function () {
    it("Should return normalized balance close to deposit amount", async function () {
      const { positionToken, lender } = await loadFixture(deployLPTFixture);

      const normalized = await positionToken.normalizedBalanceOf(lender.address);
      const depositAmount = ethers.parseUnits("50000", 6);
      const diff = normalized > depositAmount ? normalized - depositAmount : depositAmount - normalized;
      expect(diff).to.be.lt(100n); // RAY rounding tolerance
    });

    it("Should increase after interest accrues", async function () {
      const { positionToken, market, lender } = await loadFixture(deployLPTFixture);

      const normalizedBefore = await positionToken.normalizedBalanceOf(lender.address);

      // Advance 180 days
      await time.increase(180 * 24 * 3600);
      await market.accrueInterest();

      const normalizedAfter = await positionToken.normalizedBalanceOf(lender.address);
      expect(normalizedAfter).to.be.gt(normalizedBefore);
    });

    it("Should return zero for account with no balance", async function () {
      const { positionToken, nonLender } = await loadFixture(deployLPTFixture);
      expect(await positionToken.normalizedBalanceOf(nonLender.address)).to.equal(0);
    });
  });

  describe("transfer restrictions", function () {
    it("Should allow transfer between known lenders", async function () {
      const { positionToken, lender, lender2 } = await loadFixture(deployLPTFixture);
      const amount = ethers.parseUnits("1000", 6);

      await expect(positionToken.connect(lender).transfer(lender2.address, amount))
        .to.not.be.reverted;

      expect(await positionToken.balanceOf(lender2.address)).to.equal(amount);
    });

    it("Should reject transfer to non-known lender", async function () {
      const { positionToken, lender, nonLender } = await loadFixture(deployLPTFixture);
      const amount = ethers.parseUnits("1000", 6);

      await expect(
        positionToken.connect(lender).transfer(nonLender.address, amount)
      ).to.be.revertedWithCustomError(positionToken, "LenderNotKnown");
    });

    it("Should reject transferFrom to non-known lender", async function () {
      const { positionToken, lender, nonLender } = await loadFixture(deployLPTFixture);
      const amount = ethers.parseUnits("1000", 6);

      await positionToken.connect(lender).approve(nonLender.address, amount);

      await expect(
        positionToken.connect(nonLender).transferFrom(lender.address, nonLender.address, amount)
      ).to.be.revertedWithCustomError(positionToken, "LenderNotKnown");
    });
  });

  describe("mint/burn access control", function () {
    it("Should reject mint from non-market address", async function () {
      const { positionToken, lender } = await loadFixture(deployLPTFixture);

      await expect(
        positionToken.connect(lender).mint(lender.address, 1000)
      ).to.be.revertedWithCustomError(positionToken, "UnauthorizedLender");
    });

    it("Should reject burn from non-market address", async function () {
      const { positionToken, lender } = await loadFixture(deployLPTFixture);

      await expect(
        positionToken.connect(lender).burn(lender.address, 1000)
      ).to.be.revertedWithCustomError(positionToken, "UnauthorizedLender");
    });
  });

  describe("constructor validation", function () {
    it("Should revert with zero market address", async function () {
      const LPT = await ethers.getContractFactory("LoanPositionToken");

      await expect(
        LPT.deploy("Test", "TST", ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(LPT, "ZeroAddress");
    });

    it("Should revert with zero orchestrator address", async function () {
      const [signer] = await ethers.getSigners();
      const LPT = await ethers.getContractFactory("LoanPositionToken");

      await expect(
        LPT.deploy("Test", "TST", signer.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(LPT, "ZeroAddress");
    });
  });
});
