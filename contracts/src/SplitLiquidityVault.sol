// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";

/// @notice Irrecoverable v1 sink for SPLIT's liquidity allocations. Position custody
/// belongs to this contract; v1 deliberately exposes no remove/transfer/withdraw path.
contract SplitLiquidityVault is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;

    uint256 private constant Q96 = 1 << 96;
    int24 private constant TICK_SPACING = 60;

    address public immutable factory;
    address public immutable router;
    mapping(PoolId => mapping(Currency => uint256)) public pendingLiquidity;
    mapping(PoolId => mapping(Currency => bool)) public supportedCurrency;
    mapping(PoolId => uint128) public positionLiquidity;
    mapping(PoolId => bytes32) public positionSalt;
    mapping(PoolId => int24) public positionTickLower;
    mapping(PoolId => int24) public positionTickUpper;
    IPoolManager public immutable poolManager;

    error Unauthorized();
    error PositionAlreadySeeded();
    error InvalidSeed();
    error InvalidSeedDelta(int128 amount0, int128 amount1);
    error UnauthorizedManager();

    event LiquidityCredited(PoolId indexed poolId, Currency indexed currency, uint256 amount);
    event PoolLiquidityRegistered(PoolId indexed poolId, Currency currency0, Currency currency1);
    event SeedPositionCreated(PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt);

    constructor(address factory_, address router_, IPoolManager manager_) {
        require(factory_ != address(0) && router_ != address(0) && address(manager_) != address(0), "ZERO_ADDRESS");
        factory = factory_;
        router = router_;
        poolManager = manager_;
    }

    receive() external payable {}

    function credit(PoolId poolId, Currency currency, uint256 amount) external {
        if (msg.sender != router) revert Unauthorized();
        if (!supportedCurrency[poolId][currency] || amount == 0) revert InvalidSeed();
        pendingLiquidity[poolId][currency] += amount;
        emit LiquidityCredited(poolId, currency, amount);
    }

    /// @notice Restricts fee allocations to the currencies actually held by this pool.
    function registerPool(PoolId poolId, Currency currency0, Currency currency1) external {
        if (msg.sender != factory) revert Unauthorized();
        if (supportedCurrency[poolId][currency0] || supportedCurrency[poolId][currency1]) revert InvalidSeed();
        supportedCurrency[poolId][currency0] = true;
        supportedCurrency[poolId][currency1] = true;
        emit PoolLiquidityRegistered(poolId, currency0, currency1);
    }

    /// @notice Creates a full-range position through PoolManager with this vault as owner.
    /// Factory transfers the token seed before calling; quote seed is supplied as msg.value.
    function seedPosition(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        uint256 tokenAmount,
        uint256 quoteAmount,
        bytes32 salt
    ) external payable {
        if (msg.sender != factory) revert Unauthorized();
        if (
            Currency.unwrap(key.currency0) != address(0) || Currency.unwrap(key.currency1) == address(0)
                || msg.value != quoteAmount
        ) {
            revert InvalidSeed();
        }
        PoolId poolId = key.toId();
        if (positionLiquidity[poolId] != 0) revert PositionAlreadySeeded();
        if (!supportedCurrency[poolId][key.currency0] || !supportedCurrency[poolId][key.currency1]) {
            revert InvalidSeed();
        }
        (bool ok,) = address(poolManager)
            .call(
                abi.encodeWithSelector(
                    poolManager.unlock.selector, abi.encode(key, sqrtPriceX96, tokenAmount, quoteAmount, salt)
                )
            );
        if (!ok) revert InvalidSeed();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnauthorizedManager();
        (PoolKey memory key, uint160 sqrtPriceX96, uint256 tokenAmount, uint256 quoteAmount, bytes32 salt) =
            abi.decode(data, (PoolKey, uint160, uint256, uint256, bytes32));
        PoolId poolId = key.toId();
        int24 tickLower = -887220;
        int24 tickUpper = 887220;
        uint128 liquidity = _liquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            quoteAmount,
            tokenAmount
        );
        if (liquidity == 0) revert InvalidSeed();

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(liquidity)), salt), ""
        );
        int128 amount0Delta = delta.amount0();
        int128 amount1Delta = delta.amount1();
        // PoolManager deltas are from the caller's perspective: adding liquidity
        // makes the provider's delta negative (the provider owes the currency).
        if (amount0Delta > 0 || amount1Delta > 0) revert InvalidSeedDelta(amount0Delta, amount1Delta);
        // Both deltas are checked non-positive above and int128 cannot reach int256.min.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 usedQuote = uint256(-int256(amount0Delta));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 usedToken = uint256(-int256(amount1Delta));
        if (usedQuote > quoteAmount || usedToken > tokenAmount) revert InvalidSeed();

        if (usedQuote != 0) poolManager.settle{value: usedQuote}();
        if (usedToken != 0) {
            poolManager.sync(key.currency1);
            key.currency1.transfer(address(poolManager), usedToken);
            poolManager.settle();
        }

        uint256 tokenRefund = tokenAmount - usedToken;
        if (tokenRefund != 0) key.currency1.transfer(factory, tokenRefund);
        uint256 quoteRefund = quoteAmount - usedQuote;
        if (quoteRefund != 0) {
            (bool refunded,) = factory.call{value: quoteRefund}("");
            require(refunded, "QUOTE_REFUND_FAILED");
        }
        positionLiquidity[poolId] = liquidity;
        positionSalt[poolId] = salt;
        positionTickLower[poolId] = tickLower;
        positionTickUpper[poolId] = tickUpper;
        emit SeedPositionCreated(poolId, tickLower, tickUpper, liquidity, salt);
        return abi.encode(liquidity);
    }

    function _liquidityForAmounts(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 amount0, uint256 amount1)
        private
        pure
        returns (uint128)
    {
        uint256 liquidity;
        if (sqrtP <= sqrtA) {
            uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, Q96);
            liquidity = FullMath.mulDiv(amount0, intermediate, uint256(sqrtB) - sqrtA);
        } else if (sqrtP < sqrtB) {
            uint256 liquidity0 = FullMath.mulDiv(amount0, FullMath.mulDiv(sqrtP, sqrtB, Q96), uint256(sqrtB) - sqrtP);
            uint256 liquidity1 = FullMath.mulDiv(amount1, Q96, uint256(sqrtP) - sqrtA);
            liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        } else {
            liquidity = FullMath.mulDiv(amount1, Q96, uint256(sqrtB) - sqrtA);
        }
        if (liquidity > type(uint128).max) revert InvalidSeed();
        return liquidity.toUint128();
    }
}
