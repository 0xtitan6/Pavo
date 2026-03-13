// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolFlashLoanCallback} from "../pool/interfaces/IPoolCallbacks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockFlashBorrower
/// @notice Test helper that implements IPoolFlashLoanCallback for flash loan tests.
///         On callback, it approves the pool to pull back the loaned amount (happy path).
contract MockFlashBorrower is IPoolFlashLoanCallback {
    using SafeERC20 for IERC20;

    address public immutable pool;

    /// @dev Set to true after the callback is executed (for assertion in tests)
    bool public callbackExecuted;

    /// @dev Last data received in the callback
    bytes public lastData;

    /// @dev If true, the callback will attempt a reentrant flashLoan call
    bool public reentrant;

    /// @dev Token to use for reentrancy test
    address public reentrantToken;

    constructor(address _pool) {
        pool = _pool;
    }

    function setReentrant(bool _reentrant, address _token) external {
        reentrant = _reentrant;
        reentrantToken = _token;
    }

    /// @inheritdoc IPoolFlashLoanCallback
    function onPoolFlashLoan(uint256 assets, bytes calldata data) external override {
        require(msg.sender == pool, "Caller is not pool");

        callbackExecuted = true;
        lastData = data;

        if (reentrant) {
            // Attempt reentrancy — should revert with "reentrant"
            (bool success,) = pool.call(
                abi.encodeWithSignature("flashLoan(address,uint256,bytes)", reentrantToken, assets, data)
            );
            require(!success, "Reentrancy should have failed");
        }

        // Approve the pool to pull back the loaned tokens
        address token = abi.decode(data, (address));
        IERC20(token).forceApprove(pool, assets);
    }
}

/// @title MockBadFlashBorrower
/// @notice A flash borrower that does NOT repay — used to test the transfer-back revert.
contract MockBadFlashBorrower is IPoolFlashLoanCallback {
    bool public callbackExecuted;

    function onPoolFlashLoan(uint256, bytes calldata) external override {
        callbackExecuted = true;
        // Intentionally does not approve repayment — pool's safeTransferFrom will revert
    }
}
