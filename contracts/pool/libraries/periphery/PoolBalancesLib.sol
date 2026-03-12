// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue MorphoBalancesLib.sol — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {Id, MarketParams, Market, IParthenonPool} from "../../interfaces/IParthenonPool.sol";
import {IIrm} from "../../interfaces/IIrm.sol";

import {MathLib} from "../MathLib.sol";
import {UtilsLib} from "../UtilsLib.sol";
import {PoolLib} from "./PoolLib.sol";
import {SharesMathLib} from "../SharesMathLib.sol";
import {MarketParamsLib} from "../MarketParamsLib.sol";

/// @title PoolBalancesLib
/// @notice Helper library exposing getters with the expected value after interest accrual.
library PoolBalancesLib {
    using MathLib for uint256;
    using MathLib for uint128;
    using UtilsLib for uint256;
    using PoolLib for IParthenonPool;
    using SharesMathLib for uint256;
    using MarketParamsLib for MarketParams;

    /// @notice Returns the expected market balances after having accrued interest.
    function expectedMarketBalances(IParthenonPool pool, MarketParams memory marketParams)
        internal
        view
        returns (uint256, uint256, uint256, uint256)
    {
        Id id = marketParams.id();
        Market memory mkt = pool.market(id);

        uint256 elapsed = block.timestamp - mkt.lastUpdate;

        if (elapsed != 0 && mkt.totalBorrowAssets != 0 && marketParams.irm != address(0)) {
            uint256 borrowRate = IIrm(marketParams.irm).borrowRateView(marketParams, mkt);
            uint256 interest = mkt.totalBorrowAssets.wMulDown(borrowRate.wTaylorCompounded(elapsed));
            mkt.totalBorrowAssets += interest.toUint128();
            mkt.totalSupplyAssets += interest.toUint128();

            if (mkt.fee != 0) {
                uint256 feeAmount = interest.wMulDown(mkt.fee);
                uint256 feeShares =
                    feeAmount.toSharesDown(mkt.totalSupplyAssets - feeAmount, mkt.totalSupplyShares);
                mkt.totalSupplyShares += feeShares.toUint128();
            }
        }

        return (mkt.totalSupplyAssets, mkt.totalSupplyShares, mkt.totalBorrowAssets, mkt.totalBorrowShares);
    }

    /// @notice Returns the expected total supply assets after having accrued interest.
    function expectedTotalSupplyAssets(IParthenonPool pool, MarketParams memory marketParams)
        internal
        view
        returns (uint256 totalSupplyAssets)
    {
        (totalSupplyAssets,,,) = expectedMarketBalances(pool, marketParams);
    }

    /// @notice Returns the expected total borrow assets after having accrued interest.
    function expectedTotalBorrowAssets(IParthenonPool pool, MarketParams memory marketParams)
        internal
        view
        returns (uint256 totalBorrowAssets)
    {
        (,, totalBorrowAssets,) = expectedMarketBalances(pool, marketParams);
    }

    /// @notice Returns the expected supply assets balance of `user` after having accrued interest.
    function expectedSupplyAssets(IParthenonPool pool, MarketParams memory marketParams, address user)
        internal
        view
        returns (uint256)
    {
        Id id = marketParams.id();
        uint256 userSupplyShares = pool.supplyShares(id, user);
        (uint256 totalSupplyAssets, uint256 totalSupplyShares,,) = expectedMarketBalances(pool, marketParams);

        return userSupplyShares.toAssetsDown(totalSupplyAssets, totalSupplyShares);
    }

    /// @notice Returns the expected borrow assets balance of `user` after having accrued interest.
    function expectedBorrowAssets(IParthenonPool pool, MarketParams memory marketParams, address user)
        internal
        view
        returns (uint256)
    {
        Id id = marketParams.id();
        uint256 userBorrowShares = pool.borrowShares(id, user);
        (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = expectedMarketBalances(pool, marketParams);

        return userBorrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
    }
}
