// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue MorphoLib.sol — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {IParthenonPool, Id} from "../../interfaces/IParthenonPool.sol";
import {PoolStorageLib} from "./PoolStorageLib.sol";

/// @title PoolLib
/// @notice Helper library to access ParthenonPool storage variables.
/// @dev Warning: Supply and borrow getters may return outdated values that do not include accrued interest.
library PoolLib {
    function supplyShares(IParthenonPool pool, Id id, address user) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.positionSupplySharesSlot(id, user));
        return uint256(pool.extSloads(slot)[0]);
    }

    function borrowShares(IParthenonPool pool, Id id, address user) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.positionBorrowSharesAndCollateralSlot(id, user));
        return uint128(uint256(pool.extSloads(slot)[0]));
    }

    function collateral(IParthenonPool pool, Id id, address user) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.positionBorrowSharesAndCollateralSlot(id, user));
        return uint256(pool.extSloads(slot)[0] >> 128);
    }

    function totalSupplyAssets(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketTotalSupplyAssetsAndSharesSlot(id));
        return uint128(uint256(pool.extSloads(slot)[0]));
    }

    function totalSupplyShares(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketTotalSupplyAssetsAndSharesSlot(id));
        return uint256(pool.extSloads(slot)[0] >> 128);
    }

    function totalBorrowAssets(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketTotalBorrowAssetsAndSharesSlot(id));
        return uint128(uint256(pool.extSloads(slot)[0]));
    }

    function totalBorrowShares(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketTotalBorrowAssetsAndSharesSlot(id));
        return uint256(pool.extSloads(slot)[0] >> 128);
    }

    function lastUpdate(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketLastUpdateAndFeeSlot(id));
        return uint128(uint256(pool.extSloads(slot)[0]));
    }

    function fee(IParthenonPool pool, Id id) internal view returns (uint256) {
        bytes32[] memory slot = _array(PoolStorageLib.marketLastUpdateAndFeeSlot(id));
        return uint256(pool.extSloads(slot)[0] >> 128);
    }

    function _array(bytes32 x) private pure returns (bytes32[] memory) {
        bytes32[] memory res = new bytes32[](1);
        res[0] = x;
        return res;
    }
}
