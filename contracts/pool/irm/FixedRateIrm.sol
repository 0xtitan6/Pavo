// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {IIrm} from "../interfaces/IIrm.sol";
import {MarketParams, Market} from "../interfaces/IParthenonPool.sol";

/// @title FixedRateIrm
/// @notice Simple fixed-rate Interest Rate Model for ParthenonPool markets.
/// @dev Matches the DAML PoolIRM pattern — owner-configurable fixed borrow rate per second (scaled by WAD).
///      Can later be upgraded to a two-slope adaptive model if needed.
///
///      Example: 5% APR = 5e16 / (365.25 * 86400) ≈ 1_585_489_599 wei per second
contract FixedRateIrm is IIrm {
    /// @notice Maximum borrow rate per second (~317% APR) to prevent overflow in wTaylorCompounded
    /// @dev 1e17 / 31_536_000 ≈ 3_170_979_198 (100% APR = ~3.17e9 rate/sec)
    uint256 public constant MAX_RATE_PER_SECOND = 3_170_979_198;

    /// @notice Owner who can update the rate
    address public owner;

    /// @notice Borrow rate per second, scaled by WAD (1e18)
    uint256 public ratePerSecond;

    event RateUpdated(uint256 oldRate, uint256 newRate);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @param _owner          Initial owner
    /// @param _ratePerSecond  Initial borrow rate per second (WAD-scaled)
    constructor(address _owner, uint256 _ratePerSecond) {
        require(_owner != address(0), "zero owner");
        require(_ratePerSecond <= MAX_RATE_PER_SECOND, "rate too high");
        owner = _owner;
        ratePerSecond = _ratePerSecond;
        emit RateUpdated(0, _ratePerSecond);
    }

    /// @notice Set a new borrow rate per second
    /// @param _ratePerSecond New rate (WAD-scaled)
    function setRate(uint256 _ratePerSecond) external onlyOwner {
        require(_ratePerSecond <= MAX_RATE_PER_SECOND, "rate too high");
        uint256 old = ratePerSecond;
        ratePerSecond = _ratePerSecond;
        emit RateUpdated(old, _ratePerSecond);
    }

    /// @notice Transfer ownership
    /// @param _newOwner New owner address
    function setOwner(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "zero owner");
        emit OwnerUpdated(owner, _newOwner);
        owner = _newOwner;
    }

    /// @inheritdoc IIrm
    function borrowRate(MarketParams memory, Market memory) external view override returns (uint256) {
        return ratePerSecond;
    }

    /// @inheritdoc IIrm
    function borrowRateView(MarketParams memory, Market memory) external view override returns (uint256) {
        return ratePerSecond;
    }
}
