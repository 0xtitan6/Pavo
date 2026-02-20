import hre from "hardhat";

export let loanFactory: any; // LoanFactory contract instance
export let usdcMock: any;    // USDC mock contract instance
export let btcMock: any;     // BTC mock contract instance
export let loanCalculatorTest: any; // LoanCalculatorTest contract instance
export let owner: any;       // Deployer/admin account
export let lender: any;      // Account representing a lender in loan scenarios
export let borrower: any;    // Account representing a borrower in loan scenarios

// Export LoanFactory's Status enum for use in tests
export const LoanStatus = {
  s1: 0, // offer to lend
  s2: 1, // offer to borrow
  s3: 2, // ongoing loan
  s4: 3  // terminated loan
};

export async function deployContracts() {
  // Get signers from Hardhat
  [owner, lender, borrower] = await hre.ethers.getSigners();
  console.log("\nSetting up test environment for LoanFactory basic tests...");
  console.log("Owner address:", owner.address);
  console.log("Lender address:", lender.address);
  console.log("Borrower address:", borrower.address);

  // Deploy USDC mock
  usdcMock = await hre.ethers.deployContract("ERC20Mock", [
    "USD Coin",
    "USDC",
    owner.address,
    hre.ethers.parseUnits("1000000", 6)
  ]);
  await usdcMock.waitForDeployment();
  console.log("USDC Mock contract deployed at:", await usdcMock.getAddress());

  // Deploy BTC mock
  btcMock = await hre.ethers.deployContract("ERC20Mock", [
    "Bitcoin",
    "BTC",
    owner.address,
    hre.ethers.parseUnits("100", 8)
  ]);
  await btcMock.waitForDeployment();
  console.log("BTC Mock contract deployed at:", await btcMock.getAddress());

  // Deploy LoanCalculatorTest
  loanCalculatorTest = await hre.ethers.deployContract("LoanCalculatorTest");
  await loanCalculatorTest.waitForDeployment();
  console.log("LoanCalculatorTest contract deployed at:", await loanCalculatorTest.getAddress());

  // Deploy LoanFactory
  loanFactory = await hre.ethers.deployContract("LoanFactory");
  await loanFactory.waitForDeployment();
  console.log("LoanFactory contract deployed at:", await loanFactory.getAddress());
}
