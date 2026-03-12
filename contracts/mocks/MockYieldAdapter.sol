// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Mock yield adapter for testing yield surplus distribution in LoanFactory.
///         Simulates 1% yield: withdraw returns 101% of deposited principal.
///         Must be pre-funded with extra tokens to cover the yield payout.
contract MockYieldAdapter is IYieldAdapter {
    using SafeERC20 for IERC20;

    /// @notice loanId → token → deposited amount (principal)
    mapping(uint256 => mapping(address => uint256)) public deposits;

    /// @notice loanId → token → shares (== deposited amount for simplicity)
    mapping(uint256 => mapping(address => uint256)) public override sharesOf;

    /// @notice token → whether this adapter "has a market" for it
    mapping(address => bool) private _supported;

    /// @notice Yield multiplier in basis points (10000 = 100% = return exact principal)
    /// @dev Default 10100 = 101% = 1% positive yield. Set to e.g. 9500 for -5% yield.
    uint256 public yieldBps = 10100;

    /// @notice Tracks active position count for LOW-C8 guard testing
    uint256 public override totalActivePositions;

    /// @notice Enable a token for deposits
    function setSupported(address token, bool supported) external {
        _supported[token] = supported;
    }

    /// @notice Set the yield multiplier (in basis points, 10000 = no yield)
    function setYieldBps(uint256 _yieldBps) external {
        yieldBps = _yieldBps;
    }

    function deposit(address token, uint256 amount, uint256 loanId) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (deposits[loanId][token] == 0) {
            totalActivePositions++;
        }
        deposits[loanId][token] += amount;
        sharesOf[loanId][token] += amount;
    }

    function withdraw(
        address token,
        uint256 loanId,
        address to
    ) external override returns (uint256 assets) {
        uint256 principal = deposits[loanId][token];
        require(principal > 0, "No position");

        deposits[loanId][token] = 0;
        sharesOf[loanId][token] = 0;
        totalActivePositions--;

        // Simulate configurable yield (default 1%)
        assets = (principal * yieldBps) / 10000;

        IERC20(token).safeTransfer(to, assets);
    }

    function hasMarket(address token) external view override returns (bool) {
        return _supported[token];
    }

}
