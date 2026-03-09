// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../adapters/interfaces/IMorpho.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal Morpho Blue mock for testing.
///         Simulates yield by minting 1% extra on withdraw.
contract MockMorpho is IMorpho {
    using SafeERC20 for IERC20;

    // shares issued == assets deposited (1:1 for simplicity)
    mapping(address => mapping(address => uint256)) public balances; // supplier → token → assets

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256, // shares (unused)
        address onBehalf,
        bytes memory // data (unused)
    ) external override returns (uint256 assetsSupplied, uint256 sharesSupplied) {
        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        balances[onBehalf][marketParams.loanToken] += assets;
        return (assets, assets); // 1:1 shares
    }

    function withdraw(
        MarketParams memory marketParams,
        uint256, // assets (unused — we redeem by shares)
        uint256 shares,
        address onBehalf,
        address receiver
    ) external override returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        require(balances[onBehalf][marketParams.loanToken] >= shares, "Insufficient balance");
        balances[onBehalf][marketParams.loanToken] -= shares;

        // Simulate 1% yield on top of principal
        uint256 yield = shares / 100;
        uint256 total = shares + yield;

        IERC20(marketParams.loanToken).safeTransfer(receiver, total);
        return (total, shares);
    }
}
