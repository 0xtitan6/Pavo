import hre from "hardhat";

export let loanFactory: any;
export let usdcMock: any;
export let btcMock: any;
export let loanCalculatorTest: any;
export let priceOracle: any;
export let assetRegistry: any;
export let mockAggregator: any;
export let owner: any;
export let lender: any;
export let borrower: any;

// LoanFactory Status enum
export const LoanStatus = {
  s1: 0, // offer to lend
  s2: 1, // offer to borrow
  s3: 2, // ongoing loan
  s4: 3  // terminated
};

// BTC/USD mock price: 1 BTC = 50,000 USDC
// Chainlink BTC/USD feed has 8 decimals → 50,000 * 1e8
export const MOCK_BTC_PRICE = 50_000n * 10n ** 8n;

export async function deployContracts() {
  [owner, lender, borrower] = await hre.ethers.getSigners();

  // ── 1. Deploy token mocks ──
  usdcMock = await hre.ethers.deployContract("ERC20Mock", [
    "USD Coin", "USDC", owner.address, hre.ethers.parseUnits("1000000", 6), 6
  ]);
  await usdcMock.waitForDeployment();

  btcMock = await hre.ethers.deployContract("ERC20Mock", [
    "Wrapped Bitcoin", "WBTC", owner.address, hre.ethers.parseUnits("100", 8), 8
  ]);
  await btcMock.waitForDeployment();

  // ── 2. Deploy MockAggregatorV3 (BTC/USD, 8 decimals, $50,000) ──
  mockAggregator = await hre.ethers.deployContract("MockAggregatorV3", [
    8,             // feed decimals (Chainlink standard)
    MOCK_BTC_PRICE // initial answer: $50,000 with 8 decimals
  ]);
  await mockAggregator.waitForDeployment();

  // ── 3. Deploy AssetRegistry and configure tokens ──
  assetRegistry = await hre.ethers.deployContract("AssetRegistry");
  await assetRegistry.waitForDeployment();

  await assetRegistry.registerAsset(await btcMock.getAddress(),  "WBTC", "BTC/USD", 8);
  await assetRegistry.registerAsset(await usdcMock.getAddress(), "USDC", "",        6);
  await assetRegistry.setAssetSupported(await btcMock.getAddress(),  true);
  await assetRegistry.setAssetSupported(await usdcMock.getAddress(), true);
  await assetRegistry.setPairSupported(await btcMock.getAddress(), await usdcMock.getAddress(), true);

  // ── 4. Deploy PriceOracle and configure BTC/USD feed ──
  priceOracle = await hre.ethers.deployContract("PriceOracle", [owner.address]);
  await priceOracle.waitForDeployment();

  // maxStaleness: 400 days in seconds (generous for test time travel)
  await priceOracle.setFeed(await btcMock.getAddress(), await mockAggregator.getAddress(), 400 * 24 * 3600);

  // ── 5. Deploy LoanFactory (no protocol fee in tests by default) ──
  loanFactory = await hre.ethers.deployContract("LoanFactory", [
    await priceOracle.getAddress(),
    await assetRegistry.getAddress(),
    hre.ethers.ZeroAddress, // feeRecipient — zero disables fee collection
    0                       // protocolFeeBps — zero fee
  ]);
  await loanFactory.waitForDeployment();

  // ── 6. Deploy LoanCalculatorTest ──
  loanCalculatorTest = await hre.ethers.deployContract("LoanCalculatorTest");
  await loanCalculatorTest.waitForDeployment();
}
