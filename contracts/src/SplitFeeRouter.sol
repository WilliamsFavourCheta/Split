// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {SplitLiquidityVault} from "./SplitLiquidityVault.sol";

/// @notice Immutable per-pool allocations with recipient pull claims.
contract SplitFeeRouter {
    using CurrencyLibrary for Currency;

    uint256 public constant BPS = 10_000;
    uint256 public constant PROTOCOL_FEE_BPS = 100;

    struct Split {
        address creator;
        address treasury;
        address community;
        uint16 creatorBps;
        uint16 liquidityBps;
        uint16 treasuryBps;
        uint16 communityBps;
        bool configured;
    }

    address public immutable factory;
    address public immutable hook;
    SplitLiquidityVault public immutable liquidityVault;
    mapping(PoolId => Split) public splits;
    mapping(PoolId => mapping(address => mapping(Currency => uint256))) public claimable;
    mapping(PoolId => mapping(Currency => uint256)) public totalRecipientAllocated;
    mapping(PoolId => mapping(Currency => uint256)) public totalRecipientClaimed;
    uint256 private lockState = 1;

    error Unauthorized();
    error InvalidSplit();
    error AlreadyConfigured();
    error NothingToClaim();
    error TransferFailed();
    error Reentrancy();

    event SplitConfigured(
        PoolId indexed poolId,
        address indexed creator,
        address treasury,
        address community,
        uint16 creatorBps,
        uint16 liquidityBps,
        uint16 treasuryBps,
        uint16 communityBps
    );
    event FeesAllocated(
        PoolId indexed poolId,
        Currency indexed currency,
        uint256 grossAmount,
        uint256 creatorAllocation,
        uint256 treasuryAllocation,
        uint256 communityAllocation,
        uint256 liquidityAllocation
    );
    event FeesClaimed(PoolId indexed poolId, address indexed recipient, Currency indexed currency, uint256 amount);

    constructor(address factory_, address hook_, SplitLiquidityVault vault_) {
        require(factory_ != address(0) && hook_ != address(0) && address(vault_) != address(0), "ZERO_ADDRESS");
        factory = factory_;
        hook = hook_;
        liquidityVault = vault_;
    }

    function configure(
        PoolId poolId,
        address creator,
        address treasury,
        address community,
        uint16 creatorBps,
        uint16 liquidityBps,
        uint16 treasuryBps,
        uint16 communityBps
    ) external {
        if (msg.sender != factory) revert Unauthorized();
        if (splits[poolId].configured) revert AlreadyConfigured();
        if (creator == address(0) || treasury == address(0) || community == address(0)) revert InvalidSplit();
        if (uint256(creatorBps) + liquidityBps + treasuryBps + communityBps != BPS) revert InvalidSplit();
        splits[poolId] = Split(creator, treasury, community, creatorBps, liquidityBps, treasuryBps, communityBps, true);
        emit SplitConfigured(poolId, creator, treasury, community, creatorBps, liquidityBps, treasuryBps, communityBps);
    }

    /// @notice Permissionlessly records allocations after the hook has taken its accrued fee.
    /// No external calls are made to Creator, Treasury, or Community.
    function route(PoolId poolId, Currency currency, uint256 grossAmount) external payable {
        if (msg.sender != hook) revert Unauthorized();
        if (lockState != 1) revert Reentrancy();
        lockState = 2;
        Split memory split = splits[poolId];
        if (!split.configured || grossAmount == 0) revert InvalidSplit();
        if (currency.isAddressZero()) {
            require(msg.value == grossAmount, "BAD_VALUE");
        } else {
            require(msg.value == 0, "UNEXPECTED_VALUE");
        }

        uint256 creatorAmount = grossAmount * split.creatorBps / BPS;
        uint256 treasuryAmount = grossAmount * split.treasuryBps / BPS;
        uint256 communityAmount = grossAmount * split.communityBps / BPS;
        // Assign all integer rounding dust to the irrevocable liquidity allocation.
        uint256 liquidityAmount = grossAmount - creatorAmount - treasuryAmount - communityAmount;

        claimable[poolId][split.creator][currency] += creatorAmount;
        claimable[poolId][split.treasury][currency] += treasuryAmount;
        claimable[poolId][split.community][currency] += communityAmount;
        uint256 recipientAmount = creatorAmount + treasuryAmount + communityAmount;
        totalRecipientAllocated[poolId][currency] += recipientAmount;

        if (liquidityAmount != 0) {
            if (currency.isAddressZero()) {
                (bool ok,) = address(liquidityVault).call{value: liquidityAmount}("");
                require(ok, "VAULT_TRANSFER_FAILED");
            } else {
                currency.transfer(address(liquidityVault), liquidityAmount);
            }
            liquidityVault.credit(poolId, currency, liquidityAmount);
        }
        emit FeesAllocated(
            poolId, currency, grossAmount, creatorAmount, treasuryAmount, communityAmount, liquidityAmount
        );
        lockState = 1;
    }

    /// @notice Claims only the caller's balance for one isolated project and currency.
    function claim(PoolId poolId, Currency currency) external {
        if (lockState != 1) revert Reentrancy();
        uint256 amount = claimable[poolId][msg.sender][currency];
        if (amount == 0) revert NothingToClaim();
        lockState = 2;
        claimable[poolId][msg.sender][currency] = 0;
        totalRecipientClaimed[poolId][currency] += amount;

        if (currency.isAddressZero()) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            currency.transfer(msg.sender, amount);
        }
        emit FeesClaimed(poolId, msg.sender, currency, amount);
        lockState = 1;
    }
}
