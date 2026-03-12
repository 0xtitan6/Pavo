// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue MorphoStorageLib.sol — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {Id} from "../../interfaces/IParthenonPool.sol";

/// @title PoolStorageLib
/// @notice Helper library exposing getters to access ParthenonPool storage variables' slot.
library PoolStorageLib {
    /* SLOTS */

    uint256 internal constant OWNER_SLOT = 0;
    uint256 internal constant PENDING_OWNER_SLOT = 1;
    uint256 internal constant FEE_RECIPIENT_SLOT = 2;
    uint256 internal constant POSITION_SLOT = 3;
    uint256 internal constant MARKET_SLOT = 4;
    uint256 internal constant IS_IRM_ENABLED_SLOT = 5;
    uint256 internal constant IS_LLTV_ENABLED_SLOT = 6;
    uint256 internal constant IS_AUTHORIZED_SLOT = 7;
    uint256 internal constant NONCE_SLOT = 8;
    uint256 internal constant ID_TO_MARKET_PARAMS_SLOT = 9;

    /* SLOT OFFSETS */

    uint256 internal constant SUPPLY_SHARES_OFFSET = 0;
    uint256 internal constant BORROW_SHARES_AND_COLLATERAL_OFFSET = 1;

    uint256 internal constant TOTAL_SUPPLY_ASSETS_AND_SHARES_OFFSET = 0;
    uint256 internal constant TOTAL_BORROW_ASSETS_AND_SHARES_OFFSET = 1;
    uint256 internal constant LAST_UPDATE_AND_FEE_OFFSET = 2;

    /* GETTERS */

    function ownerSlot() internal pure returns (bytes32) {
        return bytes32(OWNER_SLOT);
    }

    function feeRecipientSlot() internal pure returns (bytes32) {
        return bytes32(FEE_RECIPIENT_SLOT);
    }

    function positionSupplySharesSlot(Id id, address user) internal pure returns (bytes32) {
        return
            bytes32(
                uint256(keccak256(abi.encode(user, keccak256(abi.encode(id, POSITION_SLOT))))) + SUPPLY_SHARES_OFFSET
            );
    }

    function positionBorrowSharesAndCollateralSlot(Id id, address user) internal pure returns (bytes32) {
        return bytes32(
            uint256(keccak256(abi.encode(user, keccak256(abi.encode(id, POSITION_SLOT)))))
                + BORROW_SHARES_AND_COLLATERAL_OFFSET
        );
    }

    function marketTotalSupplyAssetsAndSharesSlot(Id id) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(id, MARKET_SLOT))) + TOTAL_SUPPLY_ASSETS_AND_SHARES_OFFSET);
    }

    function marketTotalBorrowAssetsAndSharesSlot(Id id) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(id, MARKET_SLOT))) + TOTAL_BORROW_ASSETS_AND_SHARES_OFFSET);
    }

    function marketLastUpdateAndFeeSlot(Id id) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(id, MARKET_SLOT))) + LAST_UPDATE_AND_FEE_OFFSET);
    }

    function isIrmEnabledSlot(address irm) internal pure returns (bytes32) {
        return keccak256(abi.encode(irm, IS_IRM_ENABLED_SLOT));
    }

    function isLltvEnabledSlot(uint256 lltv) internal pure returns (bytes32) {
        return keccak256(abi.encode(lltv, IS_LLTV_ENABLED_SLOT));
    }

    function isAuthorizedSlot(address authorizer, address authorizee) internal pure returns (bytes32) {
        return keccak256(abi.encode(authorizee, keccak256(abi.encode(authorizer, IS_AUTHORIZED_SLOT))));
    }

    function nonceSlot(address authorizer) internal pure returns (bytes32) {
        return keccak256(abi.encode(authorizer, NONCE_SLOT));
    }
}
