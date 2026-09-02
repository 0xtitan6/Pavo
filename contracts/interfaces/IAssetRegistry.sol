// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title IAssetRegistry
/// @notice Interface for the Pavo Asset Registry
/// @dev Manages supported tokens, their metadata, Chainlink feed keys, and valid trading pairs
interface IAssetRegistry {

    // ========================================================================
    // STRUCTS
    // ========================================================================

    /// @notice Metadata for a registered asset
    /// @param symbol Human-readable ticker (e.g., "WBTC", "USDC")
    /// @param feedKey Key used to resolve the Chainlink price feed in PriceOracle
    /// @param decimals Token decimals (must match the ERC20's decimals())
    /// @param isRegistered Whether the asset has been registered (immutable once set)
    /// @param isSupported Whether the asset is currently active for new loans
    struct Asset {
        string symbol;
        string feedKey;
        uint8 decimals;
        bool isRegistered;
        bool isSupported;
    }

    // ========================================================================
    // EVENTS
    // ========================================================================

    event AssetRegistered(address indexed asset, string symbol, string feedKey, uint8 decimals);
    event AssetUpdated(address indexed asset, string symbol, string feedKey, uint8 decimals);
    event AssetSupportUpdated(address indexed asset, bool supported);
    event PairSupportUpdated(address indexed collateral, address indexed asset, bool supported);

    // ========================================================================
    // ASSET MANAGEMENT (onlyOwner)
    // ========================================================================

    /// @notice Register a new asset with its metadata
    /// @param asset The ERC20 token address
    /// @param symbol Human-readable ticker
    /// @param feedKey Key for resolving Chainlink feed in PriceOracle
    /// @param decimals Token decimals (validated against ERC20)
    function registerAsset(
        address asset, 
        string calldata symbol, 
        string calldata feedKey, 
        uint8 decimals
    ) external;

    /// @notice Enable or disable an asset for new loans
    /// @param asset The token address
    /// @param supported Whether the asset should be active
    function setAssetSupported(address asset, bool supported) external;

    /// @notice Update metadata for an already-registered asset
    /// @param asset The token address
    /// @param symbol New ticker (collision-checked)
    /// @param feedKey New Chainlink feed key
    /// @param decimals New decimals (validated against ERC20)
    function updateAsset(
        address asset, 
        string calldata symbol, 
        string calldata feedKey, 
        uint8 decimals
    ) external;

    // ========================================================================
    // PAIR MANAGEMENT (onlyOwner)
    // ========================================================================

    /// @notice Enable or disable a collateral/asset trading pair
    /// @param collateral The collateral token (e.g., WBTC)
    /// @param asset The loan asset token (e.g., USDC)
    /// @param supported Whether this pair should be allowed
    function setPairSupported(
        address collateral, 
        address asset, 
        bool supported
    ) external;

    // ========================================================================
    // QUERIES (view)
    // ========================================================================

    /// @notice Get asset metadata by token address
    function getAssetByAddress(address asset) external view returns (Asset memory);

    /// @notice Get asset metadata by symbol
    function getAssetBySymbol(string calldata symbol) external view returns (Asset memory);

    /// @notice Get all registered asset addresses
    function getAllAssets() external view returns (address[] memory);

    /// @notice Check if a token is registered AND supported
    function isSupported(address asset) external view returns (bool);

    /// @notice Check if a collateral/asset pair is valid for new loans
    function isValidPair(address collateral, address asset) external view returns (bool);
}
