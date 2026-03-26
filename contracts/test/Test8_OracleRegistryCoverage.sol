// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test8_OracleRegistryCoverage
/// @notice Covers uncovered PriceOracle and AssetRegistry paths for ≥90% coverage.
contract Test8_OracleRegistryCoverage is TestBase {

    // =========================================================================
    // PRICE ORACLE — VIEW FUNCTIONS
    // =========================================================================

    function test_PriceOracle_GetOraclePriceView() external {
        Env memory e = _deploy();
        uint256 val = e.oracle.getOraclePriceView(1e8, address(e.wbtc), 6);
        _assertEq(val, 50_000 * 1e6, "View: 1 BTC should equal 50000 USDC");
    }

    function test_PriceOracle_GetInverseOraclePriceView() external {
        Env memory e = _deploy();
        uint256 btcAmt = e.oracle.getInverseOraclePriceView(50_000 * 1e6, address(e.wbtc), 6);
        _assertEq(btcAmt, 1e8, "View: 50000 USDC should equal 1 BTC");
    }

    function test_PriceOracle_GetInverseOraclePriceUnchecked() external {
        Env memory e = _deploy();
        uint256 btcAmt = e.oracle.getInverseOraclePriceUnchecked(50_000 * 1e6, address(e.wbtc), 6);
        _assertEq(btcAmt, 1e8, "Unchecked inverse: 50000 USDC should equal 1 BTC");
    }

    // =========================================================================
    // PRICE ORACLE — UNCHECKED DOES NOT POISON lastGoodPrice
    // =========================================================================

    function test_PriceOracle_UncheckedDoesNotUpdateLastGoodPrice() external {
        Env memory e = _deploy();
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "Should start at 0");

        // Call unchecked variant
        e.oracle.getOraclePriceUnchecked(1e8, address(e.wbtc), 6);
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "Unchecked should not update lastGoodPrice");

        // Call inverse unchecked variant
        e.oracle.getInverseOraclePriceUnchecked(50_000 * 1e6, address(e.wbtc), 6);
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "Inverse unchecked should not update lastGoodPrice");

        // Call view variants
        e.oracle.getOraclePriceView(1e8, address(e.wbtc), 6);
        e.oracle.getInverseOraclePriceView(50_000 * 1e6, address(e.wbtc), 6);
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "View should not update lastGoodPrice");
    }

    // =========================================================================
    // PRICE ORACLE — TWO-STEP OWNERSHIP SUCCESS
    // =========================================================================

    function test_PriceOracle_AcceptOwnership() external {
        PriceOracle oracle = new PriceOracle(address(this));
        // address(this) is owner, transfer to a known address
        AcceptOwnerHelper helper = new AcceptOwnerHelper();
        oracle.transferOwnership(address(helper));
        _assertAddrEq(oracle.pendingOwner(), address(helper), "Pending owner should be helper");

        // Helper accepts ownership
        helper.acceptOwnership(oracle);
        _assertAddrEq(oracle.owner(), address(helper), "Owner should now be helper");
        _assertAddrEq(oracle.pendingOwner(), address(0), "Pending owner should be cleared");
    }

    // =========================================================================
    // PRICE ORACLE — SEQUENCER CHECKS
    // =========================================================================

    function test_PriceOracle_SetSequencerUptimeFeed() external {
        Env memory e = _deploy();
        MockAggregatorV3 seqFeed = new MockAggregatorV3(0, 0); // answer=0 → sequencer up
        e.oracle.setSequencerUptimeFeed(address(seqFeed));
        _assertAddrEq(address(e.oracle.sequencerUptimeFeed()), address(seqFeed), "Sequencer feed should be set");
    }

    function testFail_PriceOracle_SequencerDown() external {
        Env memory e = _deploy();
        // answer=1 → sequencer down
        MockAggregatorV3 seqFeed = new MockAggregatorV3(0, 1);
        e.oracle.setSequencerUptimeFeed(address(seqFeed));
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function testFail_PriceOracle_SequencerGracePeriod() external {
        Env memory e = _deploy();
        // answer=0 → sequencer up, startedAt=block.timestamp (just came back)
        MockAggregatorV3 seqFeed = new MockAggregatorV3(0, 0);
        e.oracle.setSequencerUptimeFeed(address(seqFeed));
        // Grace period is 3600s; startedAt = block.timestamp so timeSinceUp = 0 < 3600
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function test_PriceOracle_SequencerUpPastGracePeriod() external {
        Env memory e = _deploy();
        // Sequencer up, startedAt was long ago, feed itself is fresh
        MockAggregatorV3 seqFeed = new MockAggregatorV3(0, 0);
        // Set startedAt to 2 hours ago (past the 1h grace period), updatedAt stays current
        seqFeed.setStartedAt(block.timestamp - 7200);
        e.oracle.setSequencerUptimeFeed(address(seqFeed));
        // Should succeed — sequencer up, grace period elapsed, feed is fresh
        uint256 val = e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        _assertEq(val, 50_000 * 1e6, "Should work when sequencer up past grace");
    }

    function testFail_PriceOracle_SequencerFeedStale() external {
        Env memory e = _deploy();
        // Sequencer up, but feed itself is stale (updatedAt > SEQUENCER_MAX_STALENESS ago)
        MockAggregatorV3 seqFeed = new MockAggregatorV3(0, 0);
        seqFeed.setStartedAt(block.timestamp - 7200);
        seqFeed.setUpdatedAt(block.timestamp - 7200); // feed not updated for 2 hours
        e.oracle.setSequencerUptimeFeed(address(seqFeed));
        // Should revert with SequencerFeedStale
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    // =========================================================================
    // PRICE ORACLE — DEVIATION CIRCUIT BREAKER (DOWN)
    // =========================================================================

    function testFail_PriceOracle_DeviationCircuitBreakerDown() external {
        Env memory e = _deploy();
        // First call sets lastGoodPrice
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        // Drop price by > 50%
        e.feed.setAnswer(20_000 * 1e8);
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function test_PriceOracle_DeviationWithinThresholdPasses() external {
        Env memory e = _deploy();
        // First call sets lastGoodPrice at 50000
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        // 40% move down (within 50% threshold)
        e.feed.setAnswer(30_000 * 1e8);
        uint256 val = e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        _assertEq(val, 30_000 * 1e6, "40% drop should pass");
    }

    function test_PriceOracle_DeviationUpWithinThresholdPasses() external {
        Env memory e = _deploy();
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        // 40% move up (within 50% threshold)
        e.feed.setAnswer(70_000 * 1e8);
        uint256 val = e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        _assertEq(val, 70_000 * 1e6, "40% rise should pass");
    }

    // =========================================================================
    // PRICE ORACLE — INVERSE PRICE (checked)
    // =========================================================================

    function test_PriceOracle_GetInverseOraclePrice_UpdatesLastGoodPrice() external {
        Env memory e = _deploy();
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "Start at 0");
        e.oracle.getInverseOraclePrice(50_000 * 1e6, address(e.wbtc), 6);
        _assertGt(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "Should update");
    }

    // =========================================================================
    // PRICE ORACLE — SCALE TO ASSET (both branches)
    // =========================================================================

    function test_PriceOracle_ScaleUpDecimals() external {
        // Use an 18-decimal token to trigger fromDecimals < toDecimals branch
        Env memory e = _deploy();
        // Register a DAI-like 18-decimal token
        ERC20Mock dai = new ERC20Mock("Dai", "DAI", address(this), 1_000_000 * 1e18, 18);
        e.registry.registerAsset(address(dai), "DAI", "DAI/USD", 18);
        e.registry.setAssetSupported(address(dai), true);

        // getOraclePrice(amount=1e8 WBTC, assetDecimals=18 for DAI)
        // This exercises the else branch of _scaleToAsset where fromDecimals < toDecimals
        uint256 val = e.oracle.getOraclePrice(1e8, address(e.wbtc), 18);
        _assertEq(val, 50_000 * 1e18, "1 BTC = 50000 DAI (18 decimals)");
    }

    // =========================================================================
    // PRICE ORACLE — answeredInRound < roundId staleness
    // =========================================================================

    function testFail_PriceOracle_AnsweredInRoundLag() external {
        Env memory e = _deploy();
        // Create a feed that returns answeredInRound < roundId
        MockAggregatorV3Lagging lagFeed = new MockAggregatorV3Lagging(8, BTC_PRICE);
        e.oracle.setFeed(address(e.wbtc), address(lagFeed), 400 days);
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    // =========================================================================
    // ASSET REGISTRY — ADDITIONAL COVERAGE
    // =========================================================================

    function test_AssetRegistry_UpdateAsset_ChangeSymbol() external {
        Env memory e = _deploy();
        // Update WBTC with a new symbol
        e.registry.updateAsset(address(e.wbtc), "BTC", "BTC/USD", 8);
        IAssetRegistry.Asset memory asset = e.registry.getAssetBySymbol("BTC");
        _check(asset.isRegistered, "Updated asset should be found by new symbol");
    }

    function testFail_AssetRegistry_UpdateAsset_SymbolTaken() external {
        Env memory e = _deploy();
        // Try to update WBTC's symbol to "USDC" which is already in use
        e.registry.updateAsset(address(e.wbtc), "USDC", "BTC/USD", 8);
    }

    function testFail_AssetRegistry_SetPairUnregisteredAsset() external {
        Env memory e = _deploy();
        // collateral is registered, but asset is not
        e.registry.setPairSupported(address(e.wbtc), address(0xBEEF), true);
    }

    function test_AssetRegistry_IsValidPair_CollateralUnsupported() external {
        Env memory e = _deploy();
        // Disable WBTC support
        e.registry.setAssetSupported(address(e.wbtc), false);
        _check(!e.registry.isValidPair(address(e.wbtc), address(e.usdc)),
            "Pair should be invalid when collateral unsupported");
    }

    function test_AssetRegistry_IsValidPair_AssetUnsupported() external {
        Env memory e = _deploy();
        // Disable USDC support
        e.registry.setAssetSupported(address(e.usdc), false);
        _check(!e.registry.isValidPair(address(e.wbtc), address(e.usdc)),
            "Pair should be invalid when asset unsupported");
    }

    function test_AssetRegistry_IsSupported_Unregistered() external {
        Env memory e = _deploy();
        _check(!e.registry.isSupported(address(0xDEAD)), "Unregistered should not be supported");
    }

    function test_AssetRegistry_UpdateAsset_PreservesSupport() external {
        Env memory e = _deploy();
        // WBTC is already supported=true from _deploy
        e.registry.updateAsset(address(e.wbtc), "WBTC", "BTC/USD-v2", 8);
        _check(e.registry.isSupported(address(e.wbtc)), "Support should be preserved after update");
    }

    function testFail_AssetRegistry_RegisterDecimalsMismatch18() external {
        Env memory e = _deploy();
        // Token has 18 decimals but we pass 8
        ERC20Mock eth = new ERC20Mock("Ether", "ETH", address(this), 0, 18);
        e.registry.registerAsset(address(eth), "ETH", "ETH/USD", 8);
    }

    function test_AssetRegistry_GetAllAssets_AfterAdd() external {
        Env memory e = _deploy();
        ERC20Mock dai = new ERC20Mock("Dai", "DAI", address(this), 0, 18);
        e.registry.registerAsset(address(dai), "DAI", "DAI/USD", 18);
        _assertEq(e.registry.getAllAssets().length, 3, "Should have 3 assets after adding DAI");
    }

    function test_AssetRegistry_PairReEnable() external {
        Env memory e = _deploy();
        e.registry.setPairSupported(address(e.wbtc), address(e.usdc), false);
        _check(!e.registry.isValidPair(address(e.wbtc), address(e.usdc)), "Pair should be disabled");
        e.registry.setPairSupported(address(e.wbtc), address(e.usdc), true);
        _check(e.registry.isValidPair(address(e.wbtc), address(e.usdc)), "Pair should be re-enabled");
    }
}

/// @notice Helper to call acceptOwnership from a different address
contract AcceptOwnerHelper {
    function acceptOwnership(PriceOracle oracle) external {
        oracle.acceptOwnership();
    }
}

/// @notice Mock feed where answeredInRound < roundId (stale round data)
contract MockAggregatorV3Lagging is AggregatorV3Interface {
    uint8 private immutable _decimals;
    int256 private immutable _answer;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
    }

    function decimals() external view override returns (uint8) { return _decimals; }
    function description() external pure override returns (string memory) { return "Lagging Mock"; }
    function version() external pure override returns (uint256) { return 1; }

    function getRoundData(uint80) external view override returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        return (5, _answer, block.timestamp, block.timestamp, 4); // answeredInRound < roundId
    }

    function latestRoundData() external view override returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (5, _answer, block.timestamp, block.timestamp, 4); // answeredInRound < roundId
    }
}
