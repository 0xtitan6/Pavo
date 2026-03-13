// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {Id, MarketParams} from "../interfaces/IParthenonPool.sol";

/// @title EventsLib
/// @notice Library exposing events for ParthenonPool.
library EventsLib {
    event SetOwner(address indexed newOwner);
    event SetFee(Id indexed id, uint256 newFee);
    event SetFeeRecipient(address indexed newFeeRecipient);
    event EnableIrm(address indexed irm);
    event EnableLltv(uint256 lltv);
    event CreateMarket(Id indexed id, MarketParams marketParams);

    event Supply(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);

    event Withdraw(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );

    event Borrow(
        Id indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );

    event Repay(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);

    event SupplyCollateral(Id indexed id, address indexed caller, address indexed onBehalf, uint256 assets);

    event WithdrawCollateral(
        Id indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets
    );

    event Liquidate(
        Id indexed id,
        address indexed caller,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedAssets,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );

    event FlashLoan(address indexed caller, address indexed token, uint256 assets);

    event SetAuthorization(
        address indexed caller, address indexed authorizer, address indexed authorized, bool newIsAuthorized
    );

    event IncrementNonce(address indexed caller, address indexed authorizer, uint256 usedNonce);

    event AccrueInterest(Id indexed id, uint256 prevBorrowRate, uint256 interest, uint256 feeShares);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
}
