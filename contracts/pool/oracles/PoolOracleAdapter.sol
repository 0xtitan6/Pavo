// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {IPoolOracle} from "../interfaces/IPoolOracle.sol";
import {ORACLE_PRICE_SCALE} from "../libraries/ConstantsLib.sol";

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title PoolOracleAdapter
/// @notice Wraps PriceOracle.sol to satisfy the IPoolOracle.price() interface required by ParthenonPool markets.
/// @dev One instance per market pair (loanToken/collateralToken). Returns the price of 1 unit of collateral
///      quoted in loan token, scaled to ORACLE_PRICE_SCALE (1e36).
///
///      Example: For WBTC/USDC market where 1 BTC = $50,000:
///        price() returns 50_000 * 1e(36 + 6 - 8) = 50_000 * 1e34
///
///      Formula: price = (rawUsdPrice * 1e36) / (10^feedDecimals)
///        scaled to:  10^(36 + loanDecimals - collateralDecimals) precision
interface IPriceOracle {
    function getOraclePriceView(
        uint256 amount,
        address tokenAddress,
        uint8 assetDecimals
    ) external view returns (uint256 assetValue);
}

contract PoolOracleAdapter is IPoolOracle {
    /// @notice The ParthenonFi PriceOracle contract
    IPriceOracle public immutable oracle;

    /// @notice The loan token (asset being lent)
    address public immutable loanToken;

    /// @notice The collateral token
    address public immutable collateralToken;

    /// @notice Decimals of the loan token
    uint8 public immutable loanTokenDecimals;

    /// @notice Decimals of the collateral token
    uint8 public immutable collateralTokenDecimals;

    /// @param _oracle            PriceOracle contract address
    /// @param _loanToken         The loan token address for this market
    /// @param _collateralToken   The collateral token address for this market
    constructor(address _oracle, address _loanToken, address _collateralToken) {
        require(_oracle != address(0), "Zero oracle");
        require(_loanToken != address(0), "Zero loan token");
        require(_collateralToken != address(0), "Zero collateral token");

        oracle = IPriceOracle(_oracle);
        loanToken = _loanToken;
        collateralToken = _collateralToken;
        loanTokenDecimals = IERC20Metadata(_loanToken).decimals();
        collateralTokenDecimals = IERC20Metadata(_collateralToken).decimals();
    }

    /// @notice Returns the price of 1 unit of collateral quoted in loan token, scaled by ORACLE_PRICE_SCALE (1e36).
    /// @dev Uses PriceOracle.getOraclePriceView to get the USD value of 1 collateral unit,
    ///      then scales to the ORACLE_PRICE_SCALE format expected by ParthenonPool.
    ///
    ///      The expected format is: price of 10^collateralDecimals collateral in 10^loanDecimals loan token,
    ///      with (36 + loanDecimals - collateralDecimals) decimals of precision.
    function price() external view override returns (uint256) {
        // Get value of 1 full unit of collateral (10^collateralDecimals) in loan token terms
        uint256 oneCollateral = 10 ** collateralTokenDecimals;
        uint256 valueInLoanToken = oracle.getOraclePriceView(oneCollateral, collateralToken, loanTokenDecimals);

        // ORACLE_PRICE_SCALE format: collateral_units * price / ORACLE_PRICE_SCALE = loan_token_value
        // Therefore: price = valueInLoanToken * ORACLE_PRICE_SCALE / oneCollateral
        return (valueInLoanToken * ORACLE_PRICE_SCALE) / oneCollateral;
    }
}
