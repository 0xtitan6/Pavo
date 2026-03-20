// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '../libraries/CreditTypesLib.sol';

/// @title ILoanPositionToken - Non-rebasing ERC-20 representing lender positions
/// @notice Maps to DAML Module2.LenderPosition template
/// @dev balanceOf() returns scaled balance. Use normalizedBalanceOf() for USD value.
interface ILoanPositionToken is IERC20 {
    /// @notice Get the normalized (USD) balance for an account
    /// @dev scaledBalance * scaleFactor / RAY
    function normalizedBalanceOf(address account) external view returns (uint256);

    /// @notice Get the current scale factor from the parent market
    function scaleFactor() external view returns (uint256);

    /// @notice The credit market this token represents positions in
    function market() external view returns (address);

    /// @notice Mint scaled tokens (only callable by market)
    function mint(address to, uint256 scaledAmount) external;

    /// @notice Burn scaled tokens (only callable by market)
    function burn(address from, uint256 scaledAmount) external;

    /// @notice Sets the transferability mode
    /// @param mode The new transfer restriction mode
    function setTransferability(CreditTypesLib.Transferability mode) external;

    /// @notice Sets the custodian signature for institutional verification
    /// @param sig The custodian signature hash
    function setCustodianSignature(bytes32 sig) external;
}
