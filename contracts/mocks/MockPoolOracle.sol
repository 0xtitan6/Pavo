// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../pool/interfaces/IPoolOracle.sol";

/// @title MockPoolOracle
/// @notice Mock oracle for testing ParthenonPool — returns a configurable fixed price.
contract MockPoolOracle is IPoolOracle {
    uint256 private _price;

    constructor(uint256 initialPrice) {
        _price = initialPrice;
    }

    function price() external view override returns (uint256) {
        return _price;
    }

    function setPrice(uint256 newPrice) external {
        _price = newPrice;
    }
}
