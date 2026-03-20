// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';

import './interfaces/ILoanPositionToken.sol';
import './interfaces/IOrchestrator.sol';
import './interfaces/ICreditMarket.sol';
import './libraries/ScaleFactorLib.sol';
import './libraries/CreditErrors.sol';
import './libraries/CreditTypesLib.sol';

/// @title LoanPositionToken - Non-rebasing ERC-20 representing lender credit positions
/// @notice Maps to DAML Module2.LenderPosition template
/// @dev balanceOf() returns scaled balance (internal accounting units).
///      Use normalizedBalanceOf() to get the USD-equivalent value.
///      Transfers restricted to Known Lenders via Orchestrator registry.
contract LoanPositionToken is ERC20, ILoanPositionToken {
    address public immutable override market;
    address public immutable orchestratorAddr;

    /// @notice Transfer restriction mode
    CreditTypesLib.Transferability public transferability;

    /// @notice Custodian signature for institutional verification
    bytes32 public custodianSignature;

    modifier onlyMarket() {
        if (msg.sender != market) revert CreditErrors.UnauthorizedLender();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address _market,
        address _orchestrator
    ) ERC20(name_, symbol_) {
        if (_market == address(0) || _orchestrator == address(0)) {
            revert CreditErrors.ZeroAddress();
        }
        market = _market;
        orchestratorAddr = _orchestrator;
        transferability = CreditTypesLib.Transferability.KnownLendersOnly;
    }

    // ─── ILoanPositionToken ────────────────────────────────────────────

    /// @notice Returns the normalized (USD-equivalent) balance for an account
    /// @param account The address to check
    /// @return The normalized balance in asset units
    function normalizedBalanceOf(address account) external view override returns (uint256) {
        return ScaleFactorLib.normalizeAmount(balanceOf(account), scaleFactor());
    }

    /// @notice Returns the current scale factor from the parent market
    /// @return The scale factor (RAY = 1e27)
    function scaleFactor() public view override returns (uint256) {
        return ICreditMarket(market).getState().scaleFactor;
    }

    /// @notice Mints scaled tokens to an address
    /// @param to The recipient address
    /// @param scaledAmount The amount in scaled units
    function mint(address to, uint256 scaledAmount) external override onlyMarket {
        _mint(to, scaledAmount);
    }

    /// @notice Burns scaled tokens from an address
    /// @param from The address to burn from
    /// @param scaledAmount The amount in scaled units
    function burn(address from, uint256 scaledAmount) external override onlyMarket {
        _burn(from, scaledAmount);
    }

    // ─── Transferability Controls ───────────────────────────────────────

    /// @notice Sets the transferability mode
    /// @param mode The new transfer restriction mode
    function setTransferability(CreditTypesLib.Transferability mode) external {
        if (msg.sender != market && msg.sender != Ownable(orchestratorAddr).owner()) {
            revert CreditErrors.UnauthorizedLender();
        }
        transferability = mode;
    }

    /// @notice Sets the custodian signature for institutional verification
    /// @param sig The custodian signature hash
    function setCustodianSignature(bytes32 sig) external {
        if (msg.sender != market && msg.sender != Ownable(orchestratorAddr).owner()) {
            revert CreditErrors.UnauthorizedLender();
        }
        custodianSignature = sig;
    }

    // ─── Transfer Restriction ──────────────────────────────────────────

    /// @dev Enforces transfer restrictions based on transferability mode
    ///      Minting (from == address(0)) and burning (to == address(0)) are unrestricted.
    function _update(address from, address to, uint256 value) internal override {
        // Allow mint and burn without restriction
        if (from != address(0) && to != address(0)) {
            if (transferability == CreditTypesLib.Transferability.NonTransferable) {
                revert CreditErrors.TransfersDisabled();
            } else if (transferability == CreditTypesLib.Transferability.KnownLendersOnly) {
                // Existing behavior - check orchestrator registry
                IOrchestrator orch = IOrchestrator(orchestratorAddr);
                if (!orch.isKnownLender(market, to)) {
                    revert CreditErrors.LenderNotKnown();
                }
            }
            // Unrestricted: no checks needed
        }
        super._update(from, to, value);
    }
}
