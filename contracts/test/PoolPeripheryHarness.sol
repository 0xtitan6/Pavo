// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Id, MarketParams, IParthenonPool} from "../pool/interfaces/IParthenonPool.sol";
import {PoolBalancesLib} from "../pool/libraries/periphery/PoolBalancesLib.sol";
import {PoolLib} from "../pool/libraries/periphery/PoolLib.sol";
import {PoolStorageLib} from "../pool/libraries/periphery/PoolStorageLib.sol";

/// @title PoolPeripheryHarness
/// @notice Test harness to expose internal library functions for coverage testing.
contract PoolPeripheryHarness {
    using PoolBalancesLib for IParthenonPool;
    using PoolLib for IParthenonPool;

    IParthenonPool public immutable pool;

    constructor(address _pool) {
        pool = IParthenonPool(_pool);
    }

    // ── PoolBalancesLib ──────────────────────────────────────────────────

    function expectedMarketBalances(MarketParams memory mp)
        external
        view
        returns (uint256, uint256, uint256, uint256)
    {
        return pool.expectedMarketBalances(mp);
    }

    function expectedTotalSupplyAssets(MarketParams memory mp) external view returns (uint256) {
        return pool.expectedTotalSupplyAssets(mp);
    }

    function expectedTotalBorrowAssets(MarketParams memory mp) external view returns (uint256) {
        return pool.expectedTotalBorrowAssets(mp);
    }

    function expectedSupplyAssets(MarketParams memory mp, address user) external view returns (uint256) {
        return pool.expectedSupplyAssets(mp, user);
    }

    function expectedBorrowAssets(MarketParams memory mp, address user) external view returns (uint256) {
        return pool.expectedBorrowAssets(mp, user);
    }

    // ── PoolLib ──────────────────────────────────────────────────────────

    function supplyShares(Id id, address user) external view returns (uint256) {
        return pool.supplyShares(id, user);
    }

    function borrowShares(Id id, address user) external view returns (uint256) {
        return pool.borrowShares(id, user);
    }

    function collateral(Id id, address user) external view returns (uint256) {
        return pool.collateral(id, user);
    }

    function totalSupplyAssets(Id id) external view returns (uint256) {
        return pool.totalSupplyAssets(id);
    }

    function totalSupplyShares(Id id) external view returns (uint256) {
        return pool.totalSupplyShares(id);
    }

    function totalBorrowAssets(Id id) external view returns (uint256) {
        return pool.totalBorrowAssets(id);
    }

    function totalBorrowShares(Id id) external view returns (uint256) {
        return pool.totalBorrowShares(id);
    }

    function lastUpdate(Id id) external view returns (uint256) {
        return pool.lastUpdate(id);
    }

    function fee(Id id) external view returns (uint256) {
        return pool.fee(id);
    }

    // ── PoolStorageLib (pure slot computation) ───────────────────────────

    function ownerSlot() external pure returns (bytes32) {
        return PoolStorageLib.ownerSlot();
    }

    function feeRecipientSlot() external pure returns (bytes32) {
        return PoolStorageLib.feeRecipientSlot();
    }

    function positionSupplySharesSlot(Id id, address user) external pure returns (bytes32) {
        return PoolStorageLib.positionSupplySharesSlot(id, user);
    }

    function positionBorrowSharesAndCollateralSlot(Id id, address user) external pure returns (bytes32) {
        return PoolStorageLib.positionBorrowSharesAndCollateralSlot(id, user);
    }

    function marketTotalSupplyAssetsAndSharesSlot(Id id) external pure returns (bytes32) {
        return PoolStorageLib.marketTotalSupplyAssetsAndSharesSlot(id);
    }

    function marketTotalBorrowAssetsAndSharesSlot(Id id) external pure returns (bytes32) {
        return PoolStorageLib.marketTotalBorrowAssetsAndSharesSlot(id);
    }

    function marketLastUpdateAndFeeSlot(Id id) external pure returns (bytes32) {
        return PoolStorageLib.marketLastUpdateAndFeeSlot(id);
    }

    function isIrmEnabledSlot(address irm) external pure returns (bytes32) {
        return PoolStorageLib.isIrmEnabledSlot(irm);
    }

    function isLltvEnabledSlot(uint256 lltv) external pure returns (bytes32) {
        return PoolStorageLib.isLltvEnabledSlot(lltv);
    }

    function isAuthorizedSlot(address authorizer, address authorizee) external pure returns (bytes32) {
        return PoolStorageLib.isAuthorizedSlot(authorizer, authorizee);
    }

    function nonceSlot(address authorizer) external pure returns (bytes32) {
        return PoolStorageLib.nonceSlot(authorizer);
    }
}
