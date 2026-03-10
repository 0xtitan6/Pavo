// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestBase.sol";

/// @title Test1_RegistryOracle
/// @notice Solidity unit tests for AssetRegistry and PriceOracle.
contract Test1_RegistryOracle is TestBase {

    // =========================================================================
    // 1. ASSET REGISTRY — POSITIVE
    // =========================================================================

    function test_AssetRegistry_RegisterAsset() external {
        Env memory e = _deploy();
        IAssetRegistry.Asset memory asset = e.registry.getAssetByAddress(address(e.wbtc));
        _check(asset.isRegistered, "WBTC should be registered");
        _check(asset.isSupported,  "WBTC should be supported");
        _check(
            keccak256(bytes(asset.symbol)) == keccak256(bytes("WBTC")),
            "Symbol mismatch"
        );
        _assertEq(asset.decimals, 8, "Decimals should be 8");
    }

    function test_AssetRegistry_SymbolLookup() external {
        Env memory e = _deploy();
        IAssetRegistry.Asset memory asset = e.registry.getAssetBySymbol("USDC");
        _check(asset.isRegistered, "USDC not found by symbol");
        _assertEq(asset.decimals, 6, "USDC decimals should be 6");
    }

    function test_AssetRegistry_IsValidPair() external {
        Env memory e = _deploy();
        _check(e.registry.isValidPair(address(e.wbtc), address(e.usdc)), "WBTC/USDC pair should be valid");
    }

    function test_AssetRegistry_InvalidPairReturnsFalse() external {
        Env memory e = _deploy();
        _check(!e.registry.isValidPair(address(e.usdc), address(e.wbtc)), "Reversed pair should not be valid");
    }

    function test_AssetRegistry_SetPairUnsupported() external {
        Env memory e = _deploy();
        e.registry.setPairSupported(address(e.wbtc), address(e.usdc), false);
        _check(!e.registry.isValidPair(address(e.wbtc), address(e.usdc)), "Pair should be disabled");
    }

    function test_AssetRegistry_GetAllAssets() external {
        Env memory e = _deploy();
        _assertEq(e.registry.getAllAssets().length, 2, "Should have 2 assets");
    }

    function test_AssetRegistry_UpdateAsset() external {
        Env memory e = _deploy();
        e.registry.updateAsset(address(e.wbtc), "WBTC", "BTC/USD-v2", 8);
        IAssetRegistry.Asset memory asset = e.registry.getAssetByAddress(address(e.wbtc));
        _check(
            keccak256(bytes(asset.feedKey)) == keccak256(bytes("BTC/USD-v2")),
            "Feed key not updated"
        );
    }

    function test_AssetRegistry_SetAssetUnsupported() external {
        Env memory e = _deploy();
        e.registry.setAssetSupported(address(e.wbtc), false);
        _check(!e.registry.isSupported(address(e.wbtc)), "WBTC should be unsupported");
    }

    function test_AssetRegistry_IsSupported_Positive() external {
        Env memory e = _deploy();
        _check(e.registry.isSupported(address(e.wbtc)), "WBTC should be supported");
        _check(e.registry.isSupported(address(e.usdc)), "USDC should be supported");
    }

    // =========================================================================
    // 1. ASSET REGISTRY — NEGATIVE
    // =========================================================================

    function testFail_AssetRegistry_RegisterDuplicate() external {
        Env memory e = _deploy();
        e.registry.registerAsset(address(e.wbtc), "WBTC2", "BTC/USD", 8);
    }

    function testFail_AssetRegistry_RegisterDuplicateSymbol() external {
        Env memory e = _deploy();
        ERC20Mock wbtc2 = new ERC20Mock("WBTC2", "WBTC", address(this), 0, 8);
        e.registry.registerAsset(address(wbtc2), "WBTC", "BTC/USD", 8);
    }

    function testFail_AssetRegistry_RegisterDecimalsMismatch() external {
        Env memory e = _deploy();
        ERC20Mock dai = new ERC20Mock("Dai", "DAI", address(this), 0, 18);
        e.registry.registerAsset(address(dai), "DAI", "", 6);
    }

    function testFail_AssetRegistry_RegisterZeroAddress() external {
        Env memory e = _deploy();
        e.registry.registerAsset(address(0), "ZERO", "", 18);
    }

    function testFail_AssetRegistry_SetPairSameToken() external {
        Env memory e = _deploy();
        e.registry.setPairSupported(address(e.wbtc), address(e.wbtc), true);
    }

    function testFail_AssetRegistry_SetPairUnregisteredCollateral() external {
        Env memory e = _deploy();
        e.registry.setPairSupported(address(0xDEAD), address(e.usdc), true);
    }

    function testFail_AssetRegistry_GetAssetBySymbolNotFound() external {
        Env memory e = _deploy();
        e.registry.getAssetBySymbol("ETH");
    }

    function testFail_AssetRegistry_GetAssetByAddressNotFound() external {
        Env memory e = _deploy();
        e.registry.getAssetByAddress(address(0xDEAD));
    }

    function testFail_AssetRegistry_UpdateUnregistered() external {
        Env memory e = _deploy();
        e.registry.updateAsset(address(0xDEAD), "X", "", 18);
    }

    function testFail_AssetRegistry_SetSupportedUnregistered() external {
        Env memory e = _deploy();
        e.registry.setAssetSupported(address(0xDEAD), true);
    }

    // =========================================================================
    // 2. PRICE ORACLE — POSITIVE
    // =========================================================================

    function test_PriceOracle_GetOraclePrice() external {
        Env memory e = _deploy();
        uint256 val = e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        _assertEq(val, 50_000 * 1e6, "1 BTC should equal 50000 USDC");
    }

    function test_PriceOracle_GetInverseOraclePrice() external {
        Env memory e = _deploy();
        uint256 btcAmt = e.oracle.getInverseOraclePrice(50_000 * 1e6, address(e.wbtc), 6);
        _assertEq(btcAmt, 1e8, "50000 USDC should equal 1 BTC");
    }

    function test_PriceOracle_GetOraclePriceUnchecked() external {
        Env memory e = _deploy();
        uint256 val = e.oracle.getOraclePriceUnchecked(1e8, address(e.wbtc), 6);
        _assertEq(val, 50_000 * 1e6, "Unchecked price should match");
    }

    function test_PriceOracle_SetFeedUpdatesPrice() external {
        Env memory e = _deploy();
        MockAggregatorV3 newFeed = new MockAggregatorV3(8, 60_000 * 1e8);
        e.oracle.setFeed(address(e.wbtc), address(newFeed), 400 days);
        uint256 val = e.oracle.getOraclePriceUnchecked(1e8, address(e.wbtc), 6);
        _assertEq(val, 60_000 * 1e6, "Updated feed price should be 60000");
    }

    function test_PriceOracle_SetMaxDeviation() external {
        Env memory e = _deploy();
        e.oracle.setMaxDeviation(2000);
        _assertEq(e.oracle.maxDeviationBps(), 2000, "maxDeviationBps should be 2000");
    }

    function test_PriceOracle_PendingOwnerSetOnTransfer() external {
        Env memory e = _deploy();
        address newOwner = address(0xC3);
        e.oracle.transferOwnership(newOwner);
        _assertAddrEq(e.oracle.pendingOwner(), newOwner, "pendingOwner should be set");
    }

    function test_PriceOracle_LastGoodPriceUpdated() external {
        Env memory e = _deploy();
        _assertEq(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "lastGoodPrice should start at 0");
        e.oracle.getOraclePriceUnchecked(1e8, address(e.wbtc), 6);
        _assertGt(e.oracle.lastGoodPrice(address(e.wbtc)), 0, "lastGoodPrice should be updated");
    }

    // =========================================================================
    // 2. PRICE ORACLE — NEGATIVE
    // =========================================================================

    function testFail_PriceOracle_StalePriceReverts() external {
        Env memory e = _deploy();
        e.feed.setUpdatedAt(block.timestamp - 500 days);
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function testFail_PriceOracle_ZeroPriceReverts() external {
        Env memory e = _deploy();
        e.feed.setAnswer(0);
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function testFail_PriceOracle_NegativePriceReverts() external {
        Env memory e = _deploy();
        e.feed.setAnswer(-1);
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function testFail_PriceOracle_FeedNotConfiguredReverts() external {
        Env memory e = _deploy();
        e.oracle.getOraclePrice(1e6, address(e.usdc), 6);
    }

    function testFail_PriceOracle_SetFeedZeroToken() external {
        Env memory e = _deploy();
        e.oracle.setFeed(address(0), address(e.feed), 3600);
    }

    function testFail_PriceOracle_SetFeedZeroFeed() external {
        Env memory e = _deploy();
        e.oracle.setFeed(address(e.wbtc), address(0), 3600);
    }

    function testFail_PriceOracle_SetMaxDeviationBelowMin() external {
        Env memory e = _deploy();
        e.oracle.setMaxDeviation(50);
    }

    function testFail_PriceOracle_UnauthorizedSetFeed() external {
        PriceOracle oracle2 = new PriceOracle(address(0xABCD));
        oracle2.setFeed(address(0x1), address(0x2), 3600);
    }

    function testFail_PriceOracle_DeviationCircuitBreaker() external {
        Env memory e = _deploy();
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
        e.feed.setAnswer(100_000 * 1e8); // > 50% move
        e.oracle.getOraclePrice(1e8, address(e.wbtc), 6);
    }

    function testFail_PriceOracle_TransferOwnershipToZero() external {
        Env memory e = _deploy();
        e.oracle.transferOwnership(address(0));
    }

    function testFail_PriceOracle_AcceptOwnershipNotPending() external {
        Env memory e = _deploy();
        e.oracle.transferOwnership(address(0xC3));
        e.oracle.acceptOwnership(); // address(this) is NOT pendingOwner
    }

    function testFail_PriceOracle_ZeroOwner() external {
        new PriceOracle(address(0));
    }
}
