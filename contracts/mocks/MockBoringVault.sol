// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../adapters/interfaces/IBoringVault.sol";

/// @notice Mock Boring Vault Teller for testing ParthenonVaultAdapter.
///         Simulates bulkDeposit/bulkWithdraw with 1:1 share ratio and 1% yield on withdraw.
contract MockTeller {
    using SafeERC20 for IERC20;

    // LOW-C9 Fix: Expose vault and accountant for cross-validation
    address public vault;
    address public accountant;

    // asset → depositor → shares
    mapping(address => mapping(address => uint256)) public shares;
    // asset → total shares outstanding
    mapping(address => uint256) public totalShares;

    /// @notice Set the vault address (for cross-validation testing)
    function setVault(address _vault) external {
        vault = _vault;
    }

    /// @notice Set the accountant address (for cross-validation testing)
    function setAccountant(address _accountant) external {
        accountant = _accountant;
    }

    /// @notice Simulate bulkDeposit: pull assets, return shares 1:1
    function bulkDeposit(
        address depositAsset,
        uint256 depositAmount,
        uint256, // minimumMint (unused in mock)
        address to
    ) external returns (uint256 sharesOut) {
        IERC20(depositAsset).safeTransferFrom(msg.sender, address(this), depositAmount);
        sharesOut = depositAmount; // 1:1 for simplicity
        shares[depositAsset][to] += sharesOut;
        totalShares[depositAsset] += sharesOut;
    }

    /// @notice Simulate bulkWithdraw: burn shares, return assets + 1% yield
    function bulkWithdraw(
        address withdrawAsset,
        uint256 shareAmount,
        uint256, // minimumAssets (unused in mock)
        address to
    ) external returns (uint256 assetsOut) {
        // In real vault, msg.sender would need shares. For mock, we trust the adapter.
        shares[withdrawAsset][msg.sender] -= shareAmount;
        totalShares[withdrawAsset] -= shareAmount;

        // Simulate 1% yield
        uint256 yield = shareAmount / 100;
        assetsOut = shareAmount + yield;

        IERC20(withdrawAsset).safeTransfer(to, assetsOut);
    }
}

/// @notice Mock Accountant for testing. Returns a fixed 1:1 exchange rate.
contract MockAccountant is IAccountant {
    /// @notice Returns 1e18 (1:1 rate in 18-decimal fixed point)
    function getRate() external pure returns (uint256) {
        return 1e18;
    }

    /// @notice Returns 1e18 for any quote asset
    function getRateInQuote(address) external pure returns (uint256) {
        return 1e18;
    }

    /// @notice Same as getRate
    function getRateSafe() external pure returns (uint256) {
        return 1e18;
    }

    /// @notice No-op checkpoint for mock
    function checkpoint() external {}
}

/// @notice Configurable Mock Teller that can return zero shares/assets for branch coverage testing
contract MockTellerConfigurable {
    using SafeERC20 for IERC20;

    address public vault;
    address public accountant;
    bool public returnZeroShares;
    bool public returnZeroAssets;

    mapping(address => mapping(address => uint256)) public shares;

    function setVault(address _vault) external { vault = _vault; }
    function setAccountant(address _accountant) external { accountant = _accountant; }
    function setReturnZeroShares(bool _val) external { returnZeroShares = _val; }
    function setReturnZeroAssets(bool _val) external { returnZeroAssets = _val; }

    function bulkDeposit(
        address depositAsset,
        uint256 depositAmount,
        uint256,
        address to
    ) external returns (uint256 sharesOut) {
        IERC20(depositAsset).safeTransferFrom(msg.sender, address(this), depositAmount);
        if (returnZeroShares) return 0;
        sharesOut = depositAmount;
        shares[depositAsset][to] += sharesOut;
    }

    function bulkWithdraw(
        address withdrawAsset,
        uint256 shareAmount,
        uint256,
        address to
    ) external returns (uint256 assetsOut) {
        shares[withdrawAsset][msg.sender] -= shareAmount;
        if (returnZeroAssets) return 0;
        uint256 yield = shareAmount / 100;
        assetsOut = shareAmount + yield;
        IERC20(withdrawAsset).safeTransfer(to, assetsOut);
    }
}

/// @notice Configurable Mock Accountant for edge-case testing (rate=0, checkpoint failure).
contract MockAccountantConfigurable is IAccountant {
    uint256 public rate;
    bool public checkpointShouldRevert;

    constructor(uint256 _rate) {
        rate = _rate;
    }

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function setCheckpointShouldRevert(bool _shouldRevert) external {
        checkpointShouldRevert = _shouldRevert;
    }

    function getRate() external view returns (uint256) {
        return rate;
    }

    function getRateInQuote(address) external view returns (uint256) {
        return rate;
    }

    function getRateSafe() external view returns (uint256) {
        return rate;
    }

    function checkpoint() external view {
        require(!checkpointShouldRevert, "MockAccountant: checkpoint failed");
    }
}
