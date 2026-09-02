// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./interfaces/IAssetRegistry.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title AssetRegistry
/// @notice Manages whitelisted tokens and valid collateral/asset pairs for Pavo
/// @dev Prevents fake-token attacks (H-4) by requiring all tokens used in LoanFactory
///      to be registered, supported, and paired by the protocol owner.
///
///      Deployment order:
///      1. Deploy AssetRegistry
///      2. registerAsset(WBTC, "WBTC", "BTC/USD", 8) + registerAsset(USDC, "USDC", "", 6)
///      3. setAssetSupported(WBTC, true) + setAssetSupported(USDC, true)
///      4. setPairSupported(WBTC, USDC, true)
///      5. Deploy PriceOracle, setFeed(WBTC, chainlinkBtcUsd, 3660)
///      6. Deploy LoanFactory(_oracle, _assetRegistry)
contract AssetRegistry is IAssetRegistry, Ownable {

    // ========================================================================
    // STATE
    // ========================================================================

    /// @notice All registered asset addresses (append-only)
    address[] private assetList;

    /// @notice Token address → asset metadata
    mapping(address => Asset) private assets;

    /// @notice Symbol → token address (reverse lookup)
    mapping(string => address) private symbolToAddress;

    /// @notice collateral → asset → whether the pair is valid for new loans
    mapping(address => mapping(address => bool)) public validPairs;

    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================

    constructor() Ownable(msg.sender) {}

    // ========================================================================
    // ASSET MANAGEMENT
    // ========================================================================

    /// @inheritdoc IAssetRegistry
    function registerAsset(
        address asset, 
        string calldata symbol, 
        string calldata feedKey, 
        uint8 decimals
    ) external onlyOwner {
        require(asset != address(0), "Asset address cannot be zero");
        require(!assets[asset].isRegistered, "Asset already registered");
        require(symbolToAddress[symbol] == address(0), "Symbol already in use");

        // Validate decimals match the actual ERC20 token
        require(
            decimals == IERC20Metadata(asset).decimals(), 
            "Decimals mismatch with ERC20"
        );

        assets[asset] = Asset({
            symbol: symbol,
            feedKey: feedKey,
            decimals: decimals,
            isRegistered: true,
            isSupported: false   // Must be explicitly enabled via setAssetSupported
        });

        symbolToAddress[symbol] = asset;
        assetList.push(asset);

        emit AssetRegistered(asset, symbol, feedKey, decimals);
    }

    /// @inheritdoc IAssetRegistry
    function setAssetSupported(address asset, bool supported) external onlyOwner {
        require(assets[asset].isRegistered, "Asset not registered");
        assets[asset].isSupported = supported;
        emit AssetSupportUpdated(asset, supported);
    }

    /// @inheritdoc IAssetRegistry
    function updateAsset(
        address asset, 
        string calldata symbol, 
        string calldata feedKey, 
        uint8 decimals
    ) external onlyOwner {
        require(assets[asset].isRegistered, "Asset not registered");

        // Validate decimals still match the ERC20
        require(
            decimals == IERC20Metadata(asset).decimals(), 
            "Decimals mismatch with ERC20"
        );

        // If symbol is changing, check new symbol isn't taken
        string memory oldSymbol = assets[asset].symbol;
        if (keccak256(abi.encodePacked(oldSymbol)) != keccak256(abi.encodePacked(symbol))) {
            require(symbolToAddress[symbol] == address(0), "New symbol already in use");
            delete symbolToAddress[oldSymbol];
            symbolToAddress[symbol] = asset;
        }

        assets[asset] = Asset({
            symbol: symbol,
            feedKey: feedKey,
            decimals: decimals,
            isRegistered: true,
            isSupported: assets[asset].isSupported  // Preserve support status
        });

        emit AssetUpdated(asset, symbol, feedKey, decimals);
    }

    // ========================================================================
    // PAIR MANAGEMENT
    // ========================================================================

    /// @inheritdoc IAssetRegistry
    function setPairSupported(
        address collateral, 
        address asset, 
        bool supported
    ) external onlyOwner {
        require(assets[collateral].isRegistered, "Collateral not registered");
        require(assets[asset].isRegistered, "Asset not registered");
        require(collateral != asset, "Collateral and asset must differ");

        validPairs[collateral][asset] = supported;

        emit PairSupportUpdated(collateral, asset, supported);
    }

    // ========================================================================
    // QUERIES
    // ========================================================================

    /// @inheritdoc IAssetRegistry
    function getAssetByAddress(address asset) external view returns (Asset memory) {
        require(assets[asset].isRegistered, "Asset not registered");
        return assets[asset];
    }

    /// @inheritdoc IAssetRegistry
    function getAssetBySymbol(string calldata symbol) external view returns (Asset memory) {
        address assetAddress = symbolToAddress[symbol];
        require(assetAddress != address(0), "Asset not found for symbol");
        return assets[assetAddress];
    }

    /// @inheritdoc IAssetRegistry
    function getAllAssets() external view returns (address[] memory) {
        return assetList;
    }

    /// @inheritdoc IAssetRegistry
    function isSupported(address asset) external view returns (bool) {
        return assets[asset].isRegistered && assets[asset].isSupported;
    }

    /// @inheritdoc IAssetRegistry
    function isValidPair(address collateral, address asset) external view returns (bool) {
        return assets[collateral].isSupported 
            && assets[asset].isSupported 
            && validPairs[collateral][asset];
    }
}
