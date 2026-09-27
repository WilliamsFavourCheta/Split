// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {SplitFeeRouter} from "./SplitFeeRouter.sol";

/// @notice 1% custom swap fee hook. Deploy only at an address with low bits 0x44:
/// AFTER_SWAP plus AFTER_SWAP_RETURNS_DELTA. Other PoolManager callbacks are disabled.
contract SplitHook {
    using SafeCast for uint256;
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 public constant SWAP_FEE_BPS = 100;
    uint256 private constant BPS = 10_000;
    uint160 public constant REQUIRED_HOOK_MASK = 0x44;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    SplitFeeRouter public immutable router;
    mapping(PoolId => bool) public registeredPool;
    mapping(PoolId => mapping(Currency => uint256)) public accrued;
    mapping(PoolId => bool) private flushing;

    error Unauthorized();
    error InvalidHookAddress();
    error InvalidPool();
    error Reentrancy();

    event PoolRegistered(
        PoolId indexed poolId, Currency currency0, Currency currency1, uint24 lpFee, int24 tickSpacing
    );
    event FeesAccrued(PoolId indexed poolId, Currency indexed currency, uint256 amount, address indexed swapper);
    event FeesFlushed(PoolId indexed poolId, Currency indexed currency, uint256 amount);

    constructor(IPoolManager manager_, address factory_, SplitFeeRouter router_) {
        require(
            address(manager_) != address(0) && factory_ != address(0) && address(router_) != address(0), "ZERO_ADDRESS"
        );
        if (uint160(address(this)) & 0x3fff != REQUIRED_HOOK_MASK) revert InvalidHookAddress();
        poolManager = manager_;
        factory = factory_;
        router = router_;
    }

    receive() external payable {}

    function registerPool(PoolKey calldata key) external {
        if (msg.sender != factory) revert Unauthorized();
        if (address(key.hooks) != address(this)) revert InvalidPool();
        PoolId id = key.toId();
        if (registeredPool[id]) revert InvalidPool();
        registeredPool[id] = true;
        emit PoolRegistered(id, key.currency0, key.currency1, key.fee, key.tickSpacing);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external returns (bytes4, int128) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        PoolId poolId = key.toId();
        if (!registeredPool[poolId]) revert InvalidPool();

        // Exact-input: charge 1% of output. Exact-output: charge 1% of input.
        bool exactOutput = params.amountSpecified > 0;
        bool feeCurrency0 = params.zeroForOne == exactOutput;
        Currency feeCurrency = feeCurrency0 ? key.currency0 : key.currency1;
        int128 raw = feeCurrency0 ? delta.amount0() : delta.amount1();
        uint256 tradedAmount = uint256(raw < 0 ? -int256(raw) : int256(raw));
        uint256 fee = tradedAmount * SWAP_FEE_BPS / BPS;
        if (fee == 0) return (this.afterSwap.selector, 0);
        if (fee > uint256(uint128(type(int128).max))) revert InvalidPool();

        poolManager.take(feeCurrency, address(this), fee);
        accrued[poolId][feeCurrency] += fee;
        emit FeesAccrued(poolId, feeCurrency, fee, sender);
        return (this.afterSwap.selector, fee.toInt128());
    }

    /// @notice Permissionless processing; a failed vault credit reverts atomically and preserves accrual.
    function flush(PoolId poolId, Currency currency) external {
        if (flushing[poolId]) revert Reentrancy();
        uint256 amount = accrued[poolId][currency];
        if (amount == 0) return;
        flushing[poolId] = true;
        accrued[poolId][currency] = 0;
        if (currency.isAddressZero()) {
            router.route{value: amount}(poolId, currency, amount);
        } else {
            currency.transfer(address(router), amount);
            router.route(poolId, currency, amount);
        }
        flushing[poolId] = false;
        emit FeesFlushed(poolId, currency, amount);
    }
}
