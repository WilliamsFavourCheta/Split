// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SplitFactory} from "./SplitFactory.sol";

/// @notice Exact-input ETH/token swaps through only a registered SPLIT v4 pool.
/// @dev Deployed after the immutable SPLIT stack; requires separate security review.
contract SplitSwapExecutor is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    SplitFactory public immutable factory;
    IPoolManager public immutable poolManager;
    IHooks public immutable hook;
    bool private swapping;

    error InvalidConfiguration();
    error InvalidOfficialPool();
    error InvalidAmount();
    error Expired();
    error Slippage();
    error PartialFill();
    error UnauthorizedCallback();
    error Reentrancy();
    error TransferFailed();

    event Swapped(
        address indexed trader, address indexed token, bool indexed isBuy, uint256 amountIn, uint256 amountOut
    );

    constructor(SplitFactory factory_) {
        if (address(factory_) == address(0)) revert InvalidConfiguration();
        factory = factory_;
        poolManager = factory_.poolManager();
        hook = IHooks(address(factory_.hook()));
        if (address(poolManager) == address(0) || address(hook) == address(0)) revert InvalidConfiguration();
    }

    function officialPool(address token) public view returns (PoolKey memory key, PoolId poolId) {
        if (token == address(0) || !factory.launchedToken(token)) revert InvalidOfficialPool();
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: hook
        });
        poolId = key.toId();
        if (
            PoolId.unwrap(poolId) != PoolId.unwrap(factory.poolForToken(token)) || factory.tokenForPool(poolId) != token
        ) {
            revert InvalidOfficialPool();
        }
    }

    function buy(address token, uint256 minAmountOut, uint256 deadline) external payable returns (uint256 amountOut) {
        if (msg.value == 0 || msg.value > uint256(uint128(type(int128).max))) revert InvalidAmount();
        amountOut = _swap(token, true, msg.value, minAmountOut, deadline);
    }

    function sell(address token, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max))) revert InvalidAmount();
        amountOut = _swap(token, false, amountIn, minAmountOut, deadline);
    }

    function _swap(address token, bool isBuy, uint256 amountIn, uint256 minAmountOut, uint256 deadline)
        private
        returns (uint256 amountOut)
    {
        if (swapping) revert Reentrancy();
        if (block.timestamp > deadline) revert Expired();
        if (minAmountOut == 0) revert Slippage();
        (PoolKey memory key,) = officialPool(token);
        swapping = true;
        if (!isBuy) {
            bool ok = IERC20Minimal(token).transferFrom(msg.sender, address(this), amountIn);
            if (!ok) revert TransferFailed();
        }
        amountOut =
            abi.decode(poolManager.unlock(abi.encode(key, msg.sender, isBuy, amountIn, minAmountOut)), (uint256));
        swapping = false;
        emit Swapped(msg.sender, token, isBuy, amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !swapping) revert UnauthorizedCallback();
        (PoolKey memory key, address trader, bool isBuy, uint256 amountIn, uint256 minAmountOut) =
            abi.decode(data, (PoolKey, address, bool, uint256, uint256));
        // The callback data is supplied by this contract's own locked _swap invocation.
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 inputDelta = isBuy ? delta.amount0() : delta.amount1();
        int128 outputDelta = isBuy ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) revert InvalidAmount();
        uint256 usedIn = uint256(-int256(inputDelta));
        uint256 amountOut = uint256(int256(outputDelta));
        if (usedIn != amountIn) revert PartialFill();
        if (amountOut < minAmountOut) revert Slippage();
        if (isBuy) {
            poolManager.settle{value: amountIn}();
            poolManager.take(key.currency1, trader, amountOut);
        } else {
            poolManager.sync(key.currency1);
            key.currency1.transfer(address(poolManager), amountIn);
            poolManager.settle();
            poolManager.take(key.currency0, trader, amountOut);
        }
        return abi.encode(amountOut);
    }
}
