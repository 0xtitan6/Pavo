import { expect } from "chai";
import { ethers } from "hardhat";
import { loanFactory, deployContracts } from "../utils/deployments";
import hre from "hardhat";

// Test suite: LoanFactory tests for VeniceFi - Check
describe("LoanFactory tests for VeniceFi", function () {
  // Test case: deploy the LoanFactory successfully - Check
  it("Should deploy the LoanFactory successfully", async function () {
    await deployContracts();
    const factoryAddress = await loanFactory.getAddress();
    console.log("Testing LoanFactory deployment...");
    console.log("Deployed LoanFactory address:", factoryAddress);
    expect(factoryAddress).to.not.equal(ethers.ZeroAddress);
  });

  // Test case: have correct constants - Check
  it("Should have correct constants", async function () {
    console.log("\nTesting LoanFactory constants...");
    const minAssetAmount = await loanFactory.MIN_ASSET_AMOUNT();
    console.log("MIN_ASSET_AMOUNT:", minAssetAmount.toString());
    expect(minAssetAmount).to.equal(hre.ethers.parseUnits("100", 6));

    const minLiquidationThresholdBps = await loanFactory.MIN_LIQUIDATION_THRESHOLD_BPS();
    console.log("MIN_LIQUIDATION_THRESHOLD_BPS:", minLiquidationThresholdBps);
    expect(minLiquidationThresholdBps).to.equal(10000); // 100% - allows Scenario 4

    const maxLiquidationThresholdBps = await loanFactory.MAX_LIQUIDATION_THRESHOLD_BPS();
    console.log("MAX_LIQUIDATION_THRESHOLD_BPS:", maxLiquidationThresholdBps);
    expect(maxLiquidationThresholdBps).to.equal(15000); // 150% maximum

    const minInitialCollateralRatioBps = await loanFactory.MIN_INITIAL_COLLATERAL_RATIO_BPS();
    console.log("MIN_INITIAL_COLLATERAL_RATIO_BPS:", minInitialCollateralRatioBps);
    expect(minInitialCollateralRatioBps).to.equal(11000); // 50% to support Scenario 4

    const maxInitialCollateralRatioBps = await loanFactory.MAX_INITIAL_COLLATERAL_RATIO_BPS();
    console.log("MAX_INITIAL_COLLATERAL_RATIO_BPS:", maxInitialCollateralRatioBps);
    expect(maxInitialCollateralRatioBps).to.equal(50000);
  });

  // Test case: have correct duration array - Check
  it("Should have correct duration array", async function () {
    console.log("\nTesting DURATION_DAYS array...");
    const durations = await loanFactory.DURATION_DAYS(0);
    console.log("DURATION_DAYS[0]:", durations);
    expect(durations).to.equal(1);
    const durations1 = await loanFactory.DURATION_DAYS(1);
    console.log("DURATION_DAYS[1]:", durations1);
    expect(durations1).to.equal(7);
    const durations2 = await loanFactory.DURATION_DAYS(2);
    console.log("DURATION_DAYS[2]:", durations2);
    expect(durations2).to.equal(30);
    const durations3 = await loanFactory.DURATION_DAYS(3);
    console.log("DURATION_DAYS[3]:", durations3);
    expect(durations3).to.equal(90);
    const durations4 = await loanFactory.DURATION_DAYS(4);
    console.log("DURATION_DAYS[4]:", durations4);
    expect(durations4).to.equal(180);
    const durations5 = await loanFactory.DURATION_DAYS(5);
    console.log("DURATION_DAYS[5]:", durations5);
    expect(durations5).to.equal(365);
  });

  // Test case: have correct rate array - Check
  it("Should have correct rate array", async function () {

    console.log("\nTesting RATE_BPS array...");
    const rate0 = await loanFactory.RATE_BPS(0);
    console.log("RATE_BPS[0]:", rate0);

    expect(rate0).to.equal(400);

    const rate1 = await loanFactory.RATE_BPS(1);
    console.log("RATE_BPS[1]:", rate1);
    expect(rate1).to.equal(500);

    const rate2 = await loanFactory.RATE_BPS(2);
    console.log("RATE_BPS[2]:", rate2);
    expect(rate2).to.equal(600);

    const rate3 = await loanFactory.RATE_BPS(3);
    console.log("RATE_BPS[3]:", rate3);
    expect(rate3).to.equal(700);

    const rate4 = await loanFactory.RATE_BPS(4);
    console.log("RATE_BPS[4]:", rate4);
    expect(rate4).to.equal(800);

    const rate5 = await loanFactory.RATE_BPS(5);
    console.log("RATE_BPS[5]:", rate5);
    expect(rate5).to.equal(900);

    const rate6 = await loanFactory.RATE_BPS(6);
    console.log("RATE_BPS[6]:", rate6);
    expect(rate6).to.equal(1000);
    
    const rate7 = await loanFactory.RATE_BPS(7);
    console.log("RATE_BPS[7]:", rate7);
    expect(rate7).to.equal(1100);
  });
});