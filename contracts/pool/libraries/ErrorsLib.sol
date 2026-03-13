// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

/// @title ErrorsLib
/// @notice Library exposing error messages for ParthenonPool.
library ErrorsLib {
    string internal constant NOT_OWNER = "not owner";
    string internal constant MAX_LLTV_EXCEEDED = "max LLTV exceeded";
    string internal constant MAX_FEE_EXCEEDED = "max fee exceeded";
    string internal constant ALREADY_SET = "already set";
    string internal constant IRM_NOT_ENABLED = "IRM not enabled";
    string internal constant LLTV_NOT_ENABLED = "LLTV not enabled";
    string internal constant MARKET_ALREADY_CREATED = "market already created";
    string internal constant NO_CODE = "no code";
    string internal constant MARKET_NOT_CREATED = "market not created";
    string internal constant INCONSISTENT_INPUT = "inconsistent input";
    string internal constant ZERO_ASSETS = "zero assets";
    string internal constant ZERO_ADDRESS = "zero address";
    string internal constant UNAUTHORIZED = "unauthorized";
    string internal constant INSUFFICIENT_COLLATERAL = "insufficient collateral";
    string internal constant INSUFFICIENT_LIQUIDITY = "insufficient liquidity";
    string internal constant HEALTHY_POSITION = "position is healthy";
    string internal constant INVALID_SIGNATURE = "invalid signature";
    string internal constant SIGNATURE_EXPIRED = "signature expired";
    string internal constant INVALID_NONCE = "invalid nonce";
    string internal constant TRANSFER_REVERTED = "transfer reverted";
    string internal constant TRANSFER_RETURNED_FALSE = "transfer returned false";
    string internal constant TRANSFER_FROM_REVERTED = "transferFrom reverted";
    string internal constant TRANSFER_FROM_RETURNED_FALSE = "transferFrom returned false";
    string internal constant MAX_UINT128_EXCEEDED = "max uint128 exceeded";
}
