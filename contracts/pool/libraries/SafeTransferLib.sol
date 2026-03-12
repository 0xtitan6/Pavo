// SPDX-License-Identifier: GPL-2.0-or-later
// Forked from Morpho Blue (https://github.com/morpho-org/morpho-blue) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {IERC20Internal} from "../interfaces/IERC20Internal.sol";

import {ErrorsLib} from "./ErrorsLib.sol";

/// @title SafeTransferLib
/// @notice Library to manage transfers of tokens, even if calls to the transfer or transferFrom functions are not
/// returning a boolean.
/// @dev Scoped to contracts/pool/ only — rest of codebase uses OZ SafeERC20.
library SafeTransferLib {
    function safeTransfer(address token, address to, uint256 value) internal {
        require(token.code.length > 0, ErrorsLib.NO_CODE);

        (bool success, bytes memory returndata) =
            token.call(abi.encodeCall(IERC20Internal.transfer, (to, value)));
        require(success, ErrorsLib.TRANSFER_REVERTED);
        require(returndata.length == 0 || abi.decode(returndata, (bool)), ErrorsLib.TRANSFER_RETURNED_FALSE);
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        require(token.code.length > 0, ErrorsLib.NO_CODE);

        (bool success, bytes memory returndata) =
            token.call(abi.encodeCall(IERC20Internal.transferFrom, (from, to, value)));
        require(success, ErrorsLib.TRANSFER_FROM_REVERTED);
        require(returndata.length == 0 || abi.decode(returndata, (bool)), ErrorsLib.TRANSFER_FROM_RETURNED_FALSE);
    }
}
