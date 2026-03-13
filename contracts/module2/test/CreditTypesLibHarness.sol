// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CreditTypesLib} from "../libraries/CreditTypesLib.sol";

/// @title CreditTypesLibHarness - Exposes CreditTypesLib internal functions for testing
contract CreditTypesLibHarness {
    function tierToLimit(CreditTypesLib.CreditTier tier) external pure returns (uint128) {
        return CreditTypesLib.tierToLimit(tier);
    }
}
