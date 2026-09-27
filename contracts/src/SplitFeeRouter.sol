// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {SplitLiquidityVault} from "./SplitLiquidityVault.sol";

/// @notice Immutable per-pool allocations with recipient pull claims.
contract SplitFeeRouter {
    using CurrencyLibrary for Currency;

    uint256 public constant BPS = 10_000;
    uint256 public constant PROTOCOL_SHARE_BPS = 1_000;

    struct Split {
        address creator;
        address projectTreasury;
        address community;
        uint16 creatorBps;
        uint16 liquidityBps;
        uint16 projectTreasuryBps;
        uint16 communityBps;
        bool configured;
    }

    address public immutable factory;
    address public immutable hook;
    SplitLiquidityVault public immutable liquidityVault;
    address public immutable protocolTreasury;
    mapping(PoolId => Split) public splits;
    mapping(PoolId => mapping(address => mapping(Currency => uint256))) public claimable;
    mapping(PoolId => mapping(Currency => uint256)) public protocolClaimable;
    uint256 public protocolLaunchFeesAccrued;
    mapping(PoolId => mapping(Currency => uint256)) public totalRecipientAllocated;
    mapping(PoolId => mapping(Currency => uint256)) public totalRecipientClaimed;
    mapping(PoolId => mapping(Currency => uint256)) public totalProtocolAllocated;
    mapping(PoolId => mapping(Currency => uint256)) public totalProtocolClaimed;
    uint256 private lockState = 1;

    error Unauthorized();
    error InvalidSplit();
    error AlreadyConfigured();
    error NothingToClaim();
    error TransferFailed();
    error Reentrancy();
    error UnauthorizedProtocolClaim();

    event SplitConfigured(
        PoolId indexed poolId,
        address indexed creator,
        address projectTreasury,
        address community,
        uint16 creatorBps,
        uint16 liquidityBps,
        uint16 projectTreasuryBps,
        uint16 communityBps
    );
    event FeesAllocated(
        PoolId indexed poolId,
        Currency indexed currency,
        uint256 grossAmount,
        uint256 protocolAllocation,
        uint256 creatorAllocation,
        uint256 projectTreasuryAllocation,
        uint256 communityAllocation,
        uint256 liquidityAllocation
    );
    event FeesClaimed(PoolId indexed poolId, address indexed recipient, Currency indexed currency, uint256 amount);
    event ProtocolFeesClaimed(
        PoolId indexed poolId, Currency indexed currency, address indexed recipient, uint256 amount
    );
    event ProtocolLaunchFeeCredited(address indexed factory, uint256 amount);
    event ProtocolLaunchFeesClaimed(address indexed recipient, uint256 amount);

    constructor(address factory_, address hook_, SplitLiquidityVault vault_, address protocolTreasury_) {
        require(
            factory_ != address(0) && hook_ != address(0) && address(vault_) != address(0)
                && protocolTreasury_ != address(0),
            "ZERO_ADDRESS"
        );
        factory = factory_;
        hook = hook_;
        liquidityVault = vault_;
        protocolTreasury = protocolTreasury_;
    }

    function configure(
        PoolId poolId,
        address creator,
        address projectTreasury,
        address community,
        uint16 creatorBps,
        uint16 liquidityBps,
        uint16 projectTreasuryBps,
        uint16 communityBps
    ) external {
        if (msg.sender != factory) revert Unauthorized();
        if (splits[poolId].configured) revert AlreadyConfigured();
        if (
            creator == address(0) || community == address(0)
                || (projectTreasuryBps != 0 && projectTreasury == address(0))
        ) {
            revert InvalidSplit();
        }
        if (uint256(creatorBps) + liquidityBps + projectTreasuryBps + communityBps != BPS) revert InvalidSplit();
        splits[poolId] = Split(
            creator, projectTreasury, community, creatorBps, liquidityBps, projectTreasuryBps, communityBps, true
        );
        emit SplitConfigured(
            poolId, creator, projectTreasury, community, creatorBps, liquidityBps, projectTreasuryBps, communityBps
        );
    }

    /// @notice Records a launch fee without calling the treasury during launch.
    function creditProtocolLaunchFee() external payable {
        if (msg.sender != factory) revert Unauthorized();
        if (msg.value == 0) revert InvalidSplit();
        protocolLaunchFeesAccrued += msg.value;
        emit ProtocolLaunchFeeCredited(msg.sender, msg.value);
    }

    /// @notice Records allocations after the hook has taken its accrued fee.
    /// No external calls are made to any fee recipient during allocation.
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

        uint256 protocolAmount = grossAmount * PROTOCOL_SHARE_BPS / BPS;
        uint256 projectAmount = grossAmount - protocolAmount;
        uint256 creatorAmount = projectAmount * split.creatorBps / BPS;
        uint256 projectTreasuryAmount = projectAmount * split.projectTreasuryBps / BPS;
        uint256 communityAmount = projectAmount * split.communityBps / BPS;
        // Protocol-share fractions round down into the project share. Project
        // allocation dust is assigned to the irrevocable liquidity allocation.
        uint256 liquidityAmount = projectAmount - creatorAmount - projectTreasuryAmount - communityAmount;

        claimable[poolId][split.creator][currency] += creatorAmount;
        if (projectTreasuryAmount != 0) claimable[poolId][split.projectTreasury][currency] += projectTreasuryAmount;
        claimable[poolId][split.community][currency] += communityAmount;
        protocolClaimable[poolId][currency] += protocolAmount;
        totalProtocolAllocated[poolId][currency] += protocolAmount;
        uint256 recipientAmount = creatorAmount + projectTreasuryAmount + communityAmount;
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
            poolId,
            currency,
            grossAmount,
            protocolAmount,
            creatorAmount,
            projectTreasuryAmount,
            communityAmount,
            liquidityAmount
        );
        lockState = 1;
    }

    /// @notice The immutable global Protocol Treasury pulls swap-fee revenue per pool/currency.
    function claimProtocolFees(PoolId poolId, Currency currency) external {
        if (msg.sender != protocolTreasury) revert UnauthorizedProtocolClaim();
        if (lockState != 1) revert Reentrancy();
        uint256 amount = protocolClaimable[poolId][currency];
        if (amount == 0) revert NothingToClaim();
        lockState = 2;
        protocolClaimable[poolId][currency] = 0;
        totalProtocolClaimed[poolId][currency] += amount;
        _pay(currency, msg.sender, amount);
        emit ProtocolFeesClaimed(poolId, currency, msg.sender, amount);
        lockState = 1;
    }

    /// @notice The immutable global Protocol Treasury pulls accumulated fixed launch fees.
    function claimProtocolLaunchFees() external {
        if (msg.sender != protocolTreasury) revert UnauthorizedProtocolClaim();
        if (lockState != 1) revert Reentrancy();
        uint256 amount = protocolLaunchFeesAccrued;
        if (amount == 0) revert NothingToClaim();
        lockState = 2;
        protocolLaunchFeesAccrued = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ProtocolLaunchFeesClaimed(msg.sender, amount);
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

        _pay(currency, msg.sender, amount);
        emit FeesClaimed(poolId, msg.sender, currency, amount);
        lockState = 1;
    }

    function _pay(Currency currency, address recipient, uint256 amount) private {
        if (currency.isAddressZero()) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            currency.transfer(recipient, amount);
        }
    }
}
