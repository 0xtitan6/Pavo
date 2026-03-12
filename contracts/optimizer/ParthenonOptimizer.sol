// SPDX-License-Identifier: GPL-2.0-or-later
// Inspired by MetaMorpho (https://github.com/morpho-org/metamorpho) — attribution in ATTRIBUTION.md
pragma solidity ^0.8.28;

import {IParthenonOptimizer} from "./interfaces/IParthenonOptimizer.sol";
import {
    Id,
    MarketParams,
    Market,
    Position,
    IParthenonPool
} from "../pool/interfaces/IParthenonPool.sol";
import {MarketParamsLib} from "../pool/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "../pool/libraries/SharesMathLib.sol";
import {MathLib, WAD} from "../pool/libraries/MathLib.sol";
import {UtilsLib} from "../pool/libraries/UtilsLib.sol";

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ParthenonOptimizer
/// @notice ERC-4626 vault that optimizes yield by routing deposits across ParthenonPool markets.
/// @dev Inspired by MetaMorpho. Key features:
///      - Supply queue: ordered list of markets to deposit into
///      - Withdraw queue: ordered list of markets to withdraw from
///      - Per-market allocation caps
///      - Reallocate function for active yield optimization
///      - Fee mechanism for protocol revenue
contract ParthenonOptimizer is
    IParthenonOptimizer,
    ERC4626,
    Ownable2Step,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MathLib for uint256;
    using SharesMathLib for uint256;

    /* CONSTANTS */

    /// @dev Maximum fee: 50%
    uint256 public constant MAX_FEE = 0.5e18;

    /// @dev Maximum queue length
    uint256 public constant MAX_QUEUE_LENGTH = 30;

    /* STORAGE */

    /// @notice The ParthenonPool contract
    IParthenonPool public immutable parthenonPool;

    /// @notice Supply queue — ordered markets to deposit into
    Id[] private _supplyQueue;

    /// @notice Withdraw queue — ordered markets to withdraw from
    Id[] private _withdrawQueue;

    /// @notice Market ID → allocation cap (max assets, 0 = unlimited)
    mapping(Id => uint256) public allocationCap;

    /// @notice Market ID → whether it's a configured allocation target
    mapping(Id => bool) public isAllocatable;

    /// @notice Protocol fee (WAD-scaled)
    uint256 public fee;

    /// @notice Fee recipient
    address public feeRecipient;

    /// @notice Guardian address for emergency actions
    address public guardian;

    /// @notice Last total assets (for fee computation)
    uint256 public lastTotalAssets;

    /* CONSTRUCTOR */

    /// @param _pool       ParthenonPool contract address
    /// @param _asset      The underlying ERC-20 asset token
    /// @param _name       Vault share token name
    /// @param _symbol     Vault share token symbol
    /// @param _owner      Initial owner
    constructor(
        address _pool,
        address _asset,
        string memory _name,
        string memory _symbol,
        address _owner
    )
        ERC4626(IERC20(_asset))
        ERC20(_name, _symbol)
        Ownable(_owner)
    {
        require(_pool != address(0), "Zero pool");
        parthenonPool = IParthenonPool(_pool);
    }

    /* VIEW FUNCTIONS */

    /// @inheritdoc IParthenonOptimizer
    function pool() external view returns (address) {
        return address(parthenonPool);
    }

    /// @inheritdoc IParthenonOptimizer
    function supplyQueue(uint256 index) external view returns (Id) {
        return _supplyQueue[index];
    }

    /// @inheritdoc IParthenonOptimizer
    function withdrawQueue(uint256 index) external view returns (Id) {
        return _withdrawQueue[index];
    }

    /// @inheritdoc IParthenonOptimizer
    function supplyQueueLength() external view returns (uint256) {
        return _supplyQueue.length;
    }

    /// @inheritdoc IParthenonOptimizer
    function withdrawQueueLength() external view returns (uint256) {
        return _withdrawQueue.length;
    }

    /// @notice Total assets managed by this optimizer across all pool markets.
    /// @dev Sums supply positions across all withdraw queue markets plus idle balance.
    /// @return total The total asset value denominated in the underlying token.
    function totalAssets() public view override(ERC4626) returns (uint256 total) {
        // Sum supply positions across all withdraw queue markets
        uint256 queueLen = _withdrawQueue.length;
        for (uint256 i; i < queueLen; ++i) {
            Id id = _withdrawQueue[i];
            Market memory mkt = parthenonPool.market(id);

            uint256 supplyShares = parthenonPool.position(id, address(this)).supplyShares;
            if (supplyShares > 0) {
                total += supplyShares.toAssetsDown(mkt.totalSupplyAssets, mkt.totalSupplyShares);
            }
        }

        // Add any idle assets sitting in the optimizer
        total += IERC20(asset()).balanceOf(address(this));
    }

    /* ADMIN FUNCTIONS */

    /// @inheritdoc IParthenonOptimizer
    function setSupplyQueue(Id[] calldata newSupplyQueue) external onlyOwner {
        require(newSupplyQueue.length <= MAX_QUEUE_LENGTH, "Queue too long");

        // Validate all markets exist
        for (uint256 i; i < newSupplyQueue.length; ++i) {
            Market memory mkt = parthenonPool.market(newSupplyQueue[i]);
            require(mkt.lastUpdate != 0, "Market not created");
            isAllocatable[newSupplyQueue[i]] = true;
        }

        delete _supplyQueue;
        for (uint256 i; i < newSupplyQueue.length; ++i) {
            _supplyQueue.push(newSupplyQueue[i]);
        }

        emit SupplyQueueUpdated(msg.sender, newSupplyQueue.length);
    }

    /// @inheritdoc IParthenonOptimizer
    function setWithdrawQueue(Id[] calldata newWithdrawQueue) external onlyOwner {
        require(newWithdrawQueue.length <= MAX_QUEUE_LENGTH, "Queue too long");

        for (uint256 i; i < newWithdrawQueue.length; ++i) {
            Market memory mkt = parthenonPool.market(newWithdrawQueue[i]);
            require(mkt.lastUpdate != 0, "Market not created");
            isAllocatable[newWithdrawQueue[i]] = true;
        }

        delete _withdrawQueue;
        for (uint256 i; i < newWithdrawQueue.length; ++i) {
            _withdrawQueue.push(newWithdrawQueue[i]);
        }

        emit WithdrawQueueUpdated(msg.sender, newWithdrawQueue.length);
    }

    /// @inheritdoc IParthenonOptimizer
    function setAllocationCap(Id id, uint256 cap) external onlyOwner {
        allocationCap[id] = cap;
        emit AllocationCapUpdated(id, cap);
    }

    /// @inheritdoc IParthenonOptimizer
    function setFee(uint256 newFee) external onlyOwner {
        require(newFee <= MAX_FEE, "Fee too high");
        _accrueProtocolFee();
        fee = newFee;
        emit FeeUpdated(newFee);
    }

    /// @inheritdoc IParthenonOptimizer
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        _accrueProtocolFee();
        feeRecipient = newFeeRecipient;
        emit FeeRecipientUpdated(newFeeRecipient);
    }

    /// @inheritdoc IParthenonOptimizer
    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /// @inheritdoc IParthenonOptimizer
    function reallocate(
        Id[] calldata withdrawIds,
        uint256[] calldata withdrawAmounts,
        Id[] calldata supplyIds,
        uint256[] calldata supplyAmounts
    ) external nonReentrant {
        require(msg.sender == owner() || msg.sender == guardian, "Not authorized");
        require(withdrawIds.length == withdrawAmounts.length, "Length mismatch");
        require(supplyIds.length == supplyAmounts.length, "Length mismatch");

        // Withdraw from specified markets
        for (uint256 i; i < withdrawIds.length; ++i) {
            if (withdrawAmounts[i] == 0) continue;
            MarketParams memory params = parthenonPool.idToMarketParams(withdrawIds[i]);
            parthenonPool.withdraw(params, withdrawAmounts[i], 0, address(this), address(this));
        }

        // Supply to specified markets
        IERC20 underlying = IERC20(asset());
        for (uint256 i; i < supplyIds.length; ++i) {
            if (supplyAmounts[i] == 0) continue;
            _checkCap(supplyIds[i], supplyAmounts[i]);
            MarketParams memory params = parthenonPool.idToMarketParams(supplyIds[i]);
            underlying.forceApprove(address(parthenonPool), supplyAmounts[i]);
            parthenonPool.supply(params, supplyAmounts[i], 0, address(this), "");
        }
        // Clear any residual approval
        underlying.forceApprove(address(parthenonPool), 0);

        emit Reallocated(msg.sender, supplyIds, supplyAmounts);
    }

    /* ERC-4626 OVERRIDES */

    /// @dev On deposit, accrues fees, pulls assets, mints shares, and allocates to supply queue markets.
    /// @param caller The address initiating the deposit (source of assets).
    /// @param receiver The address receiving the minted shares.
    /// @param assets The amount of underlying assets being deposited.
    /// @param shares The amount of vault shares to mint.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _accrueProtocolFee();

        // Pull assets from caller
        SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), assets);
        _mint(receiver, shares);

        // Allocate to supply queue
        _allocateToSupplyQueue(assets);

        lastTotalAssets = totalAssets();

        emit Deposit(caller, receiver, assets, shares);
    }

    /// @dev On withdraw, accrues fees, burns shares, and pulls assets from withdraw queue markets.
    /// @param caller The address initiating the withdrawal.
    /// @param receiver The address receiving the withdrawn assets.
    /// @param _owner The address whose shares are being burned.
    /// @param assets The amount of underlying assets to withdraw.
    /// @param shares The amount of vault shares to burn.
    function _withdraw(address caller, address receiver, address _owner, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _accrueProtocolFee();

        if (caller != _owner) {
            _spendAllowance(_owner, caller, shares);
        }

        _burn(_owner, shares);

        // Try to fulfill from idle balance first, then withdraw queue
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) {
            _withdrawFromQueue(assets - idle);
        }

        SafeERC20.safeTransfer(IERC20(asset()), receiver, assets);

        lastTotalAssets = totalAssets();

        emit Withdraw(caller, receiver, _owner, assets, shares);
    }

    /* INTERNAL */

    /// @dev Allocates assets to supply queue markets in order, respecting per-market caps.
    ///      Any remainder that cannot fit stays idle in the optimizer.
    /// @param assets The total amount of underlying assets to allocate.
    function _allocateToSupplyQueue(uint256 assets) internal {
        if (_supplyQueue.length == 0) return; // Keep as idle if no queue

        IERC20 underlying = IERC20(asset());
        uint256 remaining = assets;
        uint256 supplyQueueLen = _supplyQueue.length;

        for (uint256 i; i < supplyQueueLen && remaining > 0; ++i) {
            Id id = _supplyQueue[i];
            uint256 toSupply = remaining;

            // Check cap
            uint256 cap = allocationCap[id];
            if (cap > 0) {
                Market memory mkt = parthenonPool.market(id);
                uint256 currentShares = parthenonPool.position(id, address(this)).supplyShares;
                uint256 currentAssets = currentShares.toAssetsDown(mkt.totalSupplyAssets, mkt.totalSupplyShares);
                if (currentAssets >= cap) continue;
                uint256 available = cap - currentAssets;
                if (toSupply > available) toSupply = available;
            }

            MarketParams memory params = parthenonPool.idToMarketParams(id);
            underlying.forceApprove(address(parthenonPool), toSupply);
            parthenonPool.supply(params, toSupply, 0, address(this), "");
            remaining -= toSupply;
        }

        // Clear residual approval
        underlying.forceApprove(address(parthenonPool), 0);
    }

    /// @dev Withdraws assets from withdraw queue markets in order until the full amount is satisfied.
    ///      Reverts if total available liquidity across all queued markets is insufficient.
    /// @param needed The amount of underlying assets to withdraw from pool markets.
    function _withdrawFromQueue(uint256 needed) internal {
        uint256 remaining = needed;
        uint256 withdrawQueueLen = _withdrawQueue.length;

        for (uint256 i; i < withdrawQueueLen && remaining > 0; ++i) {
            Id id = _withdrawQueue[i];
            uint256 supplyShares = parthenonPool.position(id, address(this)).supplyShares;
            if (supplyShares == 0) continue;

            Market memory mkt = parthenonPool.market(id);
            uint256 availableAssets = supplyShares.toAssetsDown(mkt.totalSupplyAssets, mkt.totalSupplyShares);

            // Can't withdraw more than what's liquid (totalSupply - totalBorrow)
            uint256 liquidity = mkt.totalSupplyAssets - mkt.totalBorrowAssets;
            if (availableAssets > liquidity) availableAssets = liquidity;

            uint256 toWithdraw = remaining > availableAssets ? availableAssets : remaining;
            if (toWithdraw == 0) continue;

            MarketParams memory params = parthenonPool.idToMarketParams(id);
            parthenonPool.withdraw(params, toWithdraw, 0, address(this), address(this));
            remaining -= toWithdraw;
        }

        require(remaining == 0, "Insufficient liquidity across markets");
    }

    /// @dev Checks that supplying `amount` to market `id` won't exceed its allocation cap.
    ///      Reverts with "Cap exceeded" if the post-supply position would breach the cap.
    ///      A cap of 0 means unlimited (no cap enforced).
    /// @param id The market identifier.
    /// @param amount The amount of assets being supplied.
    function _checkCap(Id id, uint256 amount) internal view {
        uint256 cap = allocationCap[id];
        if (cap == 0) return;

        Market memory mkt = parthenonPool.market(id);
        uint256 currentShares = parthenonPool.position(id, address(this)).supplyShares;
        uint256 currentAssets = currentShares.toAssetsDown(mkt.totalSupplyAssets, mkt.totalSupplyShares);
        require(currentAssets + amount <= cap, "Cap exceeded");
    }

    /// @dev Accrues protocol fee as dilution-based shares minted to the fee recipient.
    ///      Fee is charged on interest earned since the last accrual (currentTotalAssets - lastTotalAssets).
    ///      No-ops when fee is zero, fee recipient is unset, or no interest has been earned.
    function _accrueProtocolFee() internal {
        if (fee == 0 || feeRecipient == address(0)) {
            lastTotalAssets = totalAssets();
            return;
        }

        uint256 currentTotalAssets = totalAssets();
        if (currentTotalAssets <= lastTotalAssets) {
            lastTotalAssets = currentTotalAssets;
            return;
        }

        uint256 interest = currentTotalAssets - lastTotalAssets;
        uint256 feeAssets = interest.wMulDown(fee);

        if (feeAssets > 0 && totalSupply() > 0) {
            // Mint fee shares to feeRecipient (dilution-based fee)
            uint256 feeShares = _convertToShares(feeAssets, Math.Rounding.Floor);
            if (feeShares > 0) {
                _mint(feeRecipient, feeShares);
            }
        }

        lastTotalAssets = currentTotalAssets;
    }
}
