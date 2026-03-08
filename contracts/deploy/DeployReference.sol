// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../PriceOracle.sol";
import "../AssetRegistry.sol";
import "../LoanFactory.sol";

/// @title Deployment Script Reference for VeniceFi
/// @notice Shows how to deploy and configure the full protocol stack
/// @dev This is a reference — adapt to your deployment framework (Foundry, Hardhat, etc.)

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * DEPLOYMENT ORDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 1: Deploy AssetRegistry
 * Step 2: Register assets (WBTC, USDC) and enable the WBTC/USDC pair
 * Step 3: Deploy PriceOracle
 * Step 4: Configure BTC/USD Chainlink feed on PriceOracle
 * Step 5: Deploy LoanFactory with PriceOracle + AssetRegistry addresses
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TOKEN ADDRESSES (Ethereum Mainnet)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WBTC:  0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599  (8 decimals)
 * USDC:  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  (6 decimals)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHAINLINK BTC/USD FEED ADDRESSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ethereum Mainnet:
 *   BTC/USD: 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c
 *   Heartbeat: 3600s (1 hour)
 *   Deviation: 0.5%
 *   Decimals: 8
 *
 * Ethereum Sepolia (testnet):
 *   BTC/USD: 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43
 *   
 * Arbitrum Mainnet:
 *   BTC/USD: 0x6ce185860a4963106506C203335A2910413708e9
 *   Sequencer Uptime Feed: 0xFdB631F5EE196F0ed6FAa767959853A9F217697D
 *
 * Polygon Mainnet:
 *   BTC/USD: 0xc907E116054Ad103354f2D350FD2514433D57F6f
 *
 * Base Mainnet:
 *   BTC/USD: 0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F
 *   Sequencer Uptime Feed: 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXAMPLE: FOUNDRY DEPLOY SCRIPT (ETHEREUM MAINNET)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * // In script/Deploy.s.sol:
 *
 * import "forge-std/Script.sol";
 * import "../src/AssetRegistry.sol";
 * import "../src/PriceOracle.sol";
 * import "../src/LoanFactory.sol";
 *
 * contract DeployVeniceFi is Script {
 *     // Ethereum mainnet addresses
 *     address constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
 *     address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
 *     address constant CHAINLINK_BTC_USD = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c;
 *
 *     function run() external {
 *         uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
 *         address deployer = vm.addr(deployerPrivateKey);
 *
 *         vm.startBroadcast(deployerPrivateKey);
 *
 *         // ── Step 1: Deploy AssetRegistry ──
 *         AssetRegistry registry = new AssetRegistry();
 *
 *         // ── Step 2: Register tokens + enable pair ──
 *         registry.registerAsset(WBTC, "WBTC", "BTC/USD", 8);
 *         registry.registerAsset(USDC, "USDC", "",        6);
 *         registry.setAssetSupported(WBTC, true);
 *         registry.setAssetSupported(USDC, true);
 *         registry.setPairSupported(WBTC, USDC, true);   // WBTC as collateral, USDC as loan asset
 *
 *         // ── Step 3: Deploy PriceOracle ──
 *         PriceOracle oracle = new PriceOracle(deployer);
 *
 *         // ── Step 4: Configure BTC/USD feed ──
 *         //    Mainnet heartbeat 3600s → use 3660s max staleness (heartbeat + 60s buffer)
 *         oracle.setFeed(
 *             WBTC,
 *             CHAINLINK_BTC_USD,
 *             3660                  // maxStaleness: heartbeat + 60s buffer
 *         );
 *
 *         // ── Step 5: Deploy LoanFactory ──
 *         LoanFactory factory = new LoanFactory(
 *             address(oracle),
 *             address(registry)
 *         );
 *
 *         vm.stopBroadcast();
 *
 *         console.log("AssetRegistry deployed at:", address(registry));
 *         console.log("PriceOracle deployed at:",   address(oracle));
 *         console.log("LoanFactory deployed at:",   address(factory));
 *     }
 * }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXAMPLE: ARBITRUM DEPLOYMENT (WITH SEQUENCER CHECK)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * // After deploying oracle on Arbitrum:
 * oracle.setSequencerUptimeFeed(0xFdB631F5EE196F0ed6FAa767959853A9F217697D);
 *
 * // This enables the L2 sequencer check in PriceOracle._checkSequencer()
 * // If the Arbitrum sequencer goes down, all price-dependent operations
 * // (takeUp, liquidate, endLoan) will revert until the sequencer is up
 * // AND the 1-hour grace period has passed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADDING NEW ASSETS POST-DEPLOYMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * // Example: Adding WETH as a new collateral type
 *
 * address WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
 * address CHAINLINK_ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
 *
 * // 1. Register in AssetRegistry
 * registry.registerAsset(WETH, "WETH", "ETH/USD", 18);
 * registry.setAssetSupported(WETH, true);
 * registry.setPairSupported(WETH, USDC, true);
 *
 * // 2. Configure price feed in PriceOracle
 * oracle.setFeed(WETH, CHAINLINK_ETH_USD, 3660);
 *
 * // That's it — LoanFactory now accepts WETH/USDC loans with no redeployment.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION CHECKLIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * [ ] AssetRegistry deployed
 * [ ] WBTC registered (symbol, feedKey, decimals validated against ERC20)
 * [ ] USDC registered (symbol, feedKey, decimals validated against ERC20)
 * [ ] Both assets set to isSupported = true
 * [ ] WBTC/USDC pair enabled via setPairSupported
 * [ ] PriceOracle deployed with correct owner
 * [ ] BTC/USD feed configured with correct address for target chain
 * [ ] maxStaleness set to heartbeat + small buffer (e.g., heartbeat + 60s)
 * [ ] Sequencer uptime feed configured (if deploying on L2)
 * [ ] maxDeviationBps reviewed (default 50% — adjust if needed)
 * [ ] LoanFactory deployed with PriceOracle + AssetRegistry addresses
 * [ ] Test: registry.isValidPair(WBTC, USDC) returns true
 * [ ] Test: call oracle.getOraclePriceView() to verify price reads work
 * [ ] Test: create a lend offer → create a borrow offer → takeUpLoan
 * [ ] Test: createLoan with a fake token address → should revert
 * [ ] Test: liquidation with price manipulation on testnet
 * [ ] Owner keys secured (multisig recommended for mainnet)
 *
 */
