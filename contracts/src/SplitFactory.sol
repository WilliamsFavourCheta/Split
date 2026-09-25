// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SplitToken} from "./SplitToken.sol";
import {SplitHook} from "./SplitHook.sol";
import {SplitFeeRouter} from "./SplitFeeRouter.sol";
import {SplitLiquidityVault} from "./SplitLiquidityVault.sol";

/// @notice SPLIT v1 launcher: native ETH quote, fixed 1% hook fee, 30bp static v4 LP fee.
contract SplitFactory {
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint24 public constant LP_FEE = 3_000;
    int24 public constant TICK_SPACING = 60;
    uint256 private constant Q192 = 1 << 192;
    /// @notice v1 uses native ETH (Currency.wrap(address(0))), not WETH.
    Currency public constant APPROVED_QUOTE_CURRENCY = Currency.wrap(address(0));

    IPoolManager public immutable poolManager;
    SplitHook public immutable hook;
    SplitFeeRouter public immutable feeRouter;
    SplitLiquidityVault public immutable liquidityVault;
    address public immutable treasury;

    mapping(PoolId => address) public tokenForPool;
    mapping(address => PoolId) public poolForToken;
    mapping(address => bool) public launchedToken;

    error InvalidLaunch();
    error AlreadyLaunched();
    error PoolInitializationFailed();

    struct LaunchParams {
        string name;
        string symbol;
        uint256 tokenSeedAmount;
        uint256 creatorBps;
        uint256 liquidityBps;
        uint256 treasuryBps;
        uint256 communityBps;
        address community;
        bytes32 salt;
    }

    event TokenLaunched(
        PoolId indexed poolId,
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        Currency quoteAsset,
        uint256 totalSupply,
        uint256 seedTokenAmount,
        uint256 seedQuoteAmount,
        uint160 sqrtPriceX96,
        uint24 lpFee
    );

    constructor(
        IPoolManager manager_,
        SplitHook hook_,
        SplitFeeRouter router_,
        SplitLiquidityVault vault_,
        address treasury_
    ) {
        require(
            address(manager_) != address(0) && address(hook_) != address(0) && address(router_) != address(0)
                && address(vault_) != address(0) && treasury_ != address(0),
            "ZERO_ADDRESS"
        );
        poolManager = manager_;
        hook = hook_;
        feeRouter = router_;
        liquidityVault = vault_;
        treasury = treasury_;
    }

    receive() external payable {}

    function launch(LaunchParams calldata p) external payable returns (address token, PoolId poolId) {
        if (
            bytes(p.name).length == 0 || bytes(p.name).length > 64 || bytes(p.symbol).length == 0
                || bytes(p.symbol).length > 16 || p.tokenSeedAmount == 0 || p.tokenSeedAmount > TOTAL_SUPPLY
                || msg.value == 0 || p.community == address(0)
                || p.creatorBps + p.liquidityBps + p.treasuryBps + p.communityBps != 10_000
                || p.creatorBps > type(uint16).max || p.liquidityBps > type(uint16).max
                || p.treasuryBps > type(uint16).max || p.communityBps > type(uint16).max
        ) revert InvalidLaunch();

        SplitToken newToken = new SplitToken(p.name, p.symbol, TOTAL_SUPPLY, address(this));
        token = address(newToken);
        // Native quote is the single v1 quote currency; therefore it sorts as currency0.
        PoolKey memory key = PoolKey({
            currency0: APPROVED_QUOTE_CURRENCY,
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
        if (tokenForPool[poolId] != address(0)) revert AlreadyLaunched();

        uint160 sqrtPriceX96 = _initialSqrtPrice(msg.value, p.tokenSeedAmount);
        feeRouter.configure(
            poolId,
            msg.sender,
            treasury,
            p.community,
            uint16(p.creatorBps),
            uint16(p.liquidityBps),
            uint16(p.treasuryBps),
            uint16(p.communityBps)
        );
        hook.registerPool(key);
        liquidityVault.registerPool(poolId, key.currency0, key.currency1);
        tokenForPool[poolId] = token;
        poolForToken[token] = poolId;
        launchedToken[token] = true;

        try poolManager.initialize(key, sqrtPriceX96) returns (int24) {}
        catch {
            revert PoolInitializationFailed();
        }

        require(newToken.transfer(address(liquidityVault), p.tokenSeedAmount), "SEED_TRANSFER_FAILED");
        liquidityVault.seedPosition{value: msg.value}(key, sqrtPriceX96, p.tokenSeedAmount, msg.value, p.salt);
        uint256 creatorSupply = newToken.balanceOf(address(this));
        require(newToken.transfer(msg.sender, creatorSupply), "CREATOR_TRANSFER_FAILED");
        uint256 quoteRefund = address(this).balance;
        if (quoteRefund != 0) {
            (bool ok,) = msg.sender.call{value: quoteRefund}("");
            require(ok, "REFUND_FAILED");
        }

        emit TokenLaunched(
            poolId,
            token,
            msg.sender,
            p.name,
            p.symbol,
            key.currency0,
            TOTAL_SUPPLY,
            p.tokenSeedAmount,
            msg.value,
            sqrtPriceX96,
            LP_FEE
        );
    }

    function _initialSqrtPrice(uint256 quoteAmount, uint256 tokenAmount) private pure returns (uint160 sqrtPriceX96) {
        if (quoteAmount == 0 || tokenAmount == 0) revert InvalidLaunch();
        uint256 priceX192 = FullMath.mulDiv(tokenAmount, Q192, quoteAmount);
        uint256 root = _sqrt(priceX192);
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE || root > type(uint160).max) {
            revert InvalidLaunch();
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        sqrtPriceX96 = uint160(root);
    }

    function _sqrt(uint256 x) private pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
