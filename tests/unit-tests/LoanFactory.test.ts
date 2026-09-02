import { expect } from "chai";
import { ethers } from "hardhat";
import { loanFactory, deployContracts } from "../utils/deployments";
import hre from "hardhat";

describe("LoanFactory tests for Pavo", function () {
  beforeEach(async function () {
    await deployContracts();
  });

  it("Should deploy the LoanFactory successfully", async function () {
    const factoryAddress = await loanFactory.getAddress();
    console.log("Testing LoanFactory deployment...");
    console.log("Deployed LoanFactory address:", factoryAddress);
    expect(factoryAddress).to.not.equal(ethers.ZeroAddress);
  });

  it("Should have correct constants", async function () {
    console.log("\nTesting LoanFactory constants...");
    const minAssetUnits = await loanFactory.MIN_ASSET_UNITS();
    console.log("MIN_ASSET_UNITS:", minAssetUnits.toString());
    expect(minAssetUnits).to.equal(100);

    const minLiquidationThresholdBps = await loanFactory.MIN_LIQUIDATION_THRESHOLD_BPS();
    console.log("MIN_LIQUIDATION_THRESHOLD_BPS:", minLiquidationThresholdBps);
    expect(minLiquidationThresholdBps).to.equal(10000);

    const maxLiquidationThresholdBps = await loanFactory.MAX_LIQUIDATION_THRESHOLD_BPS();
    console.log("MAX_LIQUIDATION_THRESHOLD_BPS:", maxLiquidationThresholdBps);
    expect(maxLiquidationThresholdBps).to.equal(15000);

    const minInitialCollateralRatioBps = await loanFactory.MIN_INITIAL_COLLATERAL_RATIO_BPS();
    console.log("MIN_INITIAL_COLLATERAL_RATIO_BPS:", minInitialCollateralRatioBps);
    expect(minInitialCollateralRatioBps).to.equal(11000);

    const maxInitialCollateralRatioBps = await loanFactory.MAX_INITIAL_COLLATERAL_RATIO_BPS();
    console.log("MAX_INITIAL_COLLATERAL_RATIO_BPS:", maxInitialCollateralRatioBps);
    expect(maxInitialCollateralRatioBps).to.equal(50000);
  });

  it("Should have correct duration array", async function () {
    console.log("\nTesting DURATION_DAYS array...");
    expect(await loanFactory.DURATION_DAYS(0)).to.equal(1);
    expect(await loanFactory.DURATION_DAYS(1)).to.equal(7);
    expect(await loanFactory.DURATION_DAYS(2)).to.equal(30);
    expect(await loanFactory.DURATION_DAYS(3)).to.equal(90);
    expect(await loanFactory.DURATION_DAYS(4)).to.equal(180);
    expect(await loanFactory.DURATION_DAYS(5)).to.equal(365);
  });

  it("Should have correct rate array", async function () {
    console.log("\nTesting RATE_BPS array...");
    expect(await loanFactory.RATE_BPS(0)).to.equal(400);
    expect(await loanFactory.RATE_BPS(1)).to.equal(500);
    expect(await loanFactory.RATE_BPS(2)).to.equal(600);
    expect(await loanFactory.RATE_BPS(3)).to.equal(700);
    expect(await loanFactory.RATE_BPS(4)).to.equal(800);
    expect(await loanFactory.RATE_BPS(5)).to.equal(900);
    expect(await loanFactory.RATE_BPS(6)).to.equal(1000);
    expect(await loanFactory.RATE_BPS(7)).to.equal(1100);
  });
});
