// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SplitToken} from "../src/SplitToken.sol";
import {SplitHook} from "../src/SplitHook.sol";
import {SplitFeeRouter} from "../src/SplitFeeRouter.sol";
import {SplitLiquidityVault} from "../src/SplitLiquidityVault.sol";
import {SplitFactory} from "../src/SplitFactory.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Position} from "v4-core/libraries/Position.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert() external;
    function envExists(string calldata) external view returns (bool);
    function envString(string calldata) external view returns (string memory);
    function envUint(string calldata) external view returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
}

contract NativeReceiver {
    receive() external payable {}

    function claim(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claim(poolId, currency);
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("REJECT_NATIVE");
    }

    function claim(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claim(poolId, currency);
    }
}

contract ReentrantClaimReceiver {
    SplitFeeRouter public immutable router;
    PoolId public immutable poolId;
    Currency public immutable currency;
    bool public attempted;

    constructor(SplitFeeRouter router_, PoolId poolId_, Currency currency_) {
        router = router_;
        poolId = poolId_;
        currency = currency_;
    }

    receive() external payable {
        attempted = true;
        (bool success,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!success, "REENTRANT_CLAIM_SUCCEEDED");
    }
}

/// @dev Adversarial project recipient used to exercise native payout callbacks.
contract AdversarialReceiver {
    address private immutable controller;
    address private hookTarget;
    bytes private hookData;
    address private routerTarget;
    bytes private nestedRouteData;
    bytes private privilegedCallData;
    uint256 private expensiveIterations;
    bool private rejectNative;
    bool private rejectionIsPermanent;

    uint256 public fallbackWork;
    uint256 public received;
    bool public hookReentrySucceeded;
    bool public nestedRouteSucceeded;
    bool public privilegedCallSucceeded;

    error UnauthorizedController();

    constructor(address controller_) {
        controller = controller_;
    }

    function execute(address target, bytes calldata data) external payable returns (bytes memory result) {
        if (msg.sender != controller) revert UnauthorizedController();
        (bool ok, bytes memory returned) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 0x20), mload(returned))
            }
        }
        return returned;
    }

    function configureAttacks(
        address hook_,
        bytes calldata hookData_,
        address router_,
        bytes calldata nestedRouteData_,
        bytes calldata privilegedCallData_,
        uint256 expensiveIterations_
    ) external {
        if (msg.sender != controller) revert UnauthorizedController();
        hookTarget = hook_;
        hookData = hookData_;
        routerTarget = router_;
        nestedRouteData = nestedRouteData_;
        privilegedCallData = privilegedCallData_;
        expensiveIterations = expensiveIterations_;
    }

    function permanentlyRejectNative() external {
        if (msg.sender != controller) revert UnauthorizedController();
        rejectNative = true;
        rejectionIsPermanent = true;
    }

    receive() external payable {
        if (rejectNative) revert("PERMANENT_NATIVE_REJECTION");
        received += msg.value;
        if (hookTarget != address(0)) {
            (hookReentrySucceeded,) = hookTarget.call(hookData);
        }
        if (routerTarget != address(0)) {
            (nestedRouteSucceeded,) = routerTarget.call(nestedRouteData);
            (privilegedCallSucceeded,) = routerTarget.call(privilegedCallData);
        }
        uint256 work;
        for (uint256 i; i < expensiveIterations; ++i) {
            work = uint256(keccak256(abi.encode(work, i)));
        }
        fallbackWork = work;
    }

    function isPermanentlyRejecting() external view returns (bool) {
        return rejectNative && rejectionIsPermanent;
    }
}

contract MockPoolManager {
    function take(Currency, address to, uint256 amount) external {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "SEND_FAIL");
    }

    receive() external payable {}
}

contract MockLiquidityVault {
    mapping(PoolId => mapping(Currency => uint256)) public pendingLiquidity;
    receive() external payable {}

    function credit(PoolId poolId, Currency currency, uint256 amount) external {
        pendingLiquidity[poolId][currency] += amount;
    }
}

/// @dev Attempts to remove another address's v4 position through its own unlock callback.
contract PositionStealer is IUnlockCallback {
    IPoolManager private immutable poolManager;

    constructor(IPoolManager manager_) {
        poolManager = manager_;
    }

    function attemptRemoval(PoolKey calldata key, int24 tickLower, int24 tickUpper, bytes32 salt, uint128 liquidity)
        external
        returns (bool success)
    {
        (success,) = address(poolManager)
            .call(
                abi.encodeWithSelector(
                    poolManager.unlock.selector, abi.encode(key, tickLower, tickUpper, salt, liquidity)
                )
            );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "UNEXPECTED_POOL_MANAGER");
        (PoolKey memory key, int24 tickLower, int24 tickUpper, bytes32 salt, uint128 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, bytes32, uint128));
        poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, -int256(uint256(liquidity)), salt), ""
        );
        return "";
    }
}

/// @dev Test deployment helper uses CREATE nonce prediction to wire the intentionally
/// immutable factory/hook/router/vault references without introducing post-deploy admins.
contract SplitStackDeployer {
    error CreateNonceMismatch(
        address vault,
        address predictedVault,
        address router,
        address predictedRouter,
        address factory,
        address predictedFactory
    );

    function deploy(IPoolManager manager, address treasury)
        external
        returns (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault)
    {
        address vaultAddress = _createAddress(address(this), 1);
        address routerAddress = _createAddress(address(this), 2);
        // CREATE2 increments the creator nonce as well, so the final CREATE is nonce 4.
        address factoryAddress = _createAddress(address(this), 4);
        bytes memory hookCode = abi.encodePacked(
            type(SplitHook).creationCode, abi.encode(manager, factoryAddress, SplitFeeRouter(payable(routerAddress)))
        );
        bytes32 initCodeHash = keccak256(hookCode);
        bytes32 salt;
        address hookAddress;
        bool found;
        for (uint256 i; i < 65_536; ++i) {
            salt = bytes32(i);
            hookAddress =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
            if (uint160(hookAddress) & 0x3fff == 0x44) {
                found = true;
                break;
            }
        }
        require(found, "HOOK_SALT_NOT_FOUND");

        vault = new SplitLiquidityVault(factoryAddress, routerAddress, manager);
        router = new SplitFeeRouter(factoryAddress, hookAddress, vault);
        address deployedHook;
        assembly ("memory-safe") {
            deployedHook := create2(0, add(hookCode, 0x20), mload(hookCode), salt)
        }
        require(deployedHook == hookAddress && deployedHook != address(0), "HOOK_DEPLOY_FAILED");
        hook = SplitHook(payable(deployedHook));
        factory = new SplitFactory(manager, hook, router, vault, treasury);
        if (address(vault) != vaultAddress || address(router) != routerAddress || address(factory) != factoryAddress) {
            revert CreateNonceMismatch(
                address(vault), vaultAddress, address(router), routerAddress, address(factory), factoryAddress
            );
        }
    }

    function _createAddress(address deployer, uint8 nonce) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", deployer, bytes1(nonce))))));
    }
}

contract SplitProtocolTest is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public routedValue;
    uint256 public routedAmount;
    uint256 public routedTotal;
    PoolId public routedPool;
    Currency public routedCurrency;
    IPoolManager private activeManager;
    SplitFeeRouter private forkRouter;
    SplitLiquidityVault private forkVault;
    uint256 public lastSwapOutput;
    uint256 public lastSwapInput;
    bool private activeZeroForOne = true;

    event ForkSwapMeasured(
        bool exactOutput,
        bool zeroForOne,
        int256 rawDelta0,
        int256 rawDelta1,
        int128 hookDelta,
        int256 traderDelta0,
        int256 traderDelta1,
        uint256 fee
    );

    receive() external payable {}

    function route(PoolId poolId, Currency currency, uint256 amount) external payable {
        routedValue = msg.value;
        routedAmount = amount;
        routedTotal += amount;
        routedPool = poolId;
        routedCurrency = currency;
    }

    function testTokenHasFixedSupplyAndStandardAllowance() external {
        SplitToken token = new SplitToken("Split Unit", "SUNIT", 1_000 ether, address(this));
        require(token.totalSupply() == 1_000 ether, "SUPPLY");
        require(token.balanceOf(address(this)) == 1_000 ether, "INITIAL_BALANCE");
        require(token.approve(address(0xBEEF), 20 ether), "APPROVE");
        vm.prank(address(0xBEEF));
        require(token.transferFrom(address(this), address(0xCAFE), 7 ether), "TRANSFER_FROM");
        require(token.balanceOf(address(0xCAFE)) == 7 ether, "RECIPIENT_BALANCE");
        require(token.allowance(address(this), address(0xBEEF)) == 13 ether, "ALLOWANCE");
    }

    function testRouterAllocates40_30_20_10AndLiquidityIsNotClaimable() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(123)));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        vm.deal(address(this), 10_000);
        router.route{value: 10_000}(poolId, Currency.wrap(address(0)), 10_000);

        require(router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 4_000, "CREATOR_SHARE");
        require(router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 2_000, "TREASURY_SHARE");
        require(router.claimable(poolId, address(community), Currency.wrap(address(0))) == 1_000, "COMMUNITY_SHARE");
        require(address(vault).balance == 3_000, "VAULT_SHARE");
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 3_000, "VAULT_ACCOUNTING");
        (address configuredCreator,,,,,,,) = router.splits(poolId);
        require(configuredCreator == address(creator), "CONFIG_NOT_IMMUTABLE");
    }

    function testRouterAssignsAllRoundingDustToVault() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(124)));
        router.configure(poolId, address(creator), address(treasury), address(community), 3_333, 0, 3_333, 3_334);
        vm.deal(address(this), 101);
        router.route{value: 101}(poolId, Currency.wrap(address(0)), 101);
        require(router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 33, "CREATOR_ROUNDING");
        require(router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 33, "TREASURY_ROUNDING");
        require(router.claimable(poolId, address(community), Currency.wrap(address(0))) == 33, "COMMUNITY_ROUNDING");
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 2, "DUST_NOT_TO_VAULT");
    }

    function testUneven3333_3333_3333_1SplitConservesGrossFee() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_234)));
        router.configure(poolId, address(creator), address(treasury), address(community), 3_333, 3_333, 3_333, 1);
        vm.deal(address(this), 10_000);
        router.route{value: 10_000}(poolId, Currency.wrap(address(0)), 10_000);

        require(
            router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 3_333, "UNEQUAL_CREATOR_AMOUNT"
        );
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 3_333, "UNEQUAL_LIQUIDITY_AMOUNT");
        require(
            router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 3_333, "UNEQUAL_TREASURY_AMOUNT"
        );
        require(
            router.claimable(poolId, address(community), Currency.wrap(address(0))) == 1, "UNEQUAL_COMMUNITY_AMOUNT"
        );
        require(
            router.totalRecipientAllocated(poolId, Currency.wrap(address(0)))
                    + vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 10_000,
            "UNEQUAL_SPLIT_NOT_CONSERVED"
        );
    }

    function testSplitRejectsNon100PercentAndSecondConfiguration() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(125)));
        vm.expectRevert();
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 999);
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
        vm.expectRevert();
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
    }

    function testConfigurationRejectsZeroDestinationAndUnauthorizedCaller() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(126)));
        vm.expectRevert();
        router.configure(poolId, address(0), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
        vm.expectRevert();
        vm.prank(address(0xBEEF));
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
    }

    function testRouterSupportsEach100PercentDestination() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        address[4] memory destinations = [address(creator), address(treasury), address(community), address(vault)];
        uint16[4] memory creators = [uint16(10_000), 0, 0, 0];
        uint16[4] memory liquidity = [uint16(0), 10_000, 0, 0];
        uint16[4] memory treasuries = [uint16(0), 0, 10_000, 0];
        uint16[4] memory communities = [uint16(0), 0, 0, 10_000];
        vm.deal(address(this), 40_000);
        for (uint256 i; i < 4; ++i) {
            PoolId poolId = PoolId.wrap(bytes32(i + 1));
            router.configure(
                poolId,
                destinations[0],
                destinations[1],
                destinations[2],
                creators[i],
                liquidity[i],
                treasuries[i],
                communities[i]
            );
            router.route{value: 10_000}(poolId, Currency.wrap(address(0)), 10_000);
        }
        require(
            router.claimable(PoolId.wrap(bytes32(uint256(1))), address(creator), Currency.wrap(address(0))) == 10_000,
            "100_CREATOR"
        );
        require(
            router.claimable(PoolId.wrap(bytes32(uint256(3))), address(treasury), Currency.wrap(address(0))) == 10_000,
            "100_TREASURY"
        );
        require(
            router.claimable(PoolId.wrap(bytes32(uint256(4))), address(community), Currency.wrap(address(0))) == 10_000,
            "100_COMMUNITY"
        );
        require(
            vault.pendingLiquidity(PoolId.wrap(bytes32(uint256(2))), Currency.wrap(address(0))) == 10_000,
            "100_LIQUIDITY"
        );
    }

    function testRevertingRecipientDoesNotBlockOtherAllocationsOrFutureProcessing() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        RevertingReceiver community = new RevertingReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(999)));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        vm.deal(address(this), 20_000);
        Currency currency = Currency.wrap(address(0));
        router.route{value: 10_000}(poolId, currency, 10_000);
        require(router.claimable(poolId, address(creator), currency) == 4_000, "CREATOR_BLOCKED");
        require(router.claimable(poolId, address(treasury), currency) == 2_000, "TREASURY_BLOCKED");
        require(router.claimable(poolId, address(community), currency) == 1_000, "COMMUNITY_NOT_CLAIMABLE");
        require(vault.pendingLiquidity(poolId, currency) == 3_000, "LIQUIDITY_BLOCKED");
        router.route{value: 10_000}(poolId, currency, 10_000);
        require(router.claimable(poolId, address(creator), currency) == 8_000, "FUTURE_PROCESS_BLOCKED");
        require(router.claimable(poolId, address(community), currency) == 2_000, "FUTURE_COMMUNITY_BLOCKED");
        require(vault.pendingLiquidity(poolId, currency) == 6_000, "FUTURE_LIQUIDITY_BLOCKED");
    }

    function testCommunityRejectedClaimPreservesBalanceWhileCreatorAndTreasuryClaim() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        RevertingReceiver community = new RevertingReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_001)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.route{value: 10_000}(poolId, currency, 10_000);

        (bool communityClaimSucceeded,) =
            address(community).call(abi.encodeCall(community.claim, (router, poolId, currency)));
        require(!communityClaimSucceeded, "REJECTING_COMMUNITY_CLAIM_SUCCEEDED");
        require(router.claimable(poolId, address(community), currency) == 1_000, "FAILED_CLAIM_LOST_BALANCE");

        vm.prank(address(creator));
        router.claim(poolId, currency);
        vm.prank(address(treasury));
        router.claim(poolId, currency);
        require(address(creator).balance == 4_000, "CREATOR_CLAIM_FAILED");
        require(address(treasury).balance == 2_000, "TREASURY_CLAIM_FAILED");
        require(router.claimable(poolId, address(creator), currency) == 0, "CREATOR_NOT_CLEARED");
        require(router.claimable(poolId, address(treasury), currency) == 0, "TREASURY_NOT_CLEARED");
        require(router.claimable(poolId, address(community), currency) == 1_000, "COMMUNITY_NOT_RETRYABLE");
        require(router.totalRecipientClaimed(poolId, currency) == 6_000, "CLAIM_TOTAL_WRONG");
    }

    function testRecipientCannotClaimTwiceOrAnotherRecipientsAllocation() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_002)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.route{value: 10_000}(poolId, currency, 10_000);

        vm.prank(address(0xBAD));
        (bool thiefSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!thiefSucceeded, "THIEF_CLAIMED_FUNDS");
        vm.prank(address(creator));
        router.claim(poolId, currency);
        require(address(creator).balance == 4_000, "FIRST_CLAIM_FAILED");
        vm.prank(address(creator));
        (bool secondSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!secondSucceeded, "DOUBLE_CLAIM_SUCCEEDED");
        require(router.claimable(poolId, address(treasury), currency) == 2_000, "OTHER_BALANCE_CHANGED");
    }

    function testReentrantClaimCannotStealOrClaimTwice() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_003)));
        Currency currency = Currency.wrap(address(0));
        ReentrantClaimReceiver creator = new ReentrantClaimReceiver(router, poolId, currency);
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.route{value: 10_000}(poolId, currency, 10_000);
        vm.prank(address(creator));
        router.claim(poolId, currency);
        require(creator.attempted(), "CALLBACK_NOT_ATTEMPTED");
        require(router.claimable(poolId, address(creator), currency) == 0, "REENTRANT_DOUBLE_CLAIM");
        require(router.claimable(poolId, address(treasury), currency) == 2_000, "OTHER_FUNDS_STOLEN");
        require(router.totalRecipientClaimed(poolId, currency) == 4_000, "CLAIMED_TOTAL_WRONG");
    }

    function testClaimsAreIsolatedByPoolAndCurrency() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId firstPool = PoolId.wrap(bytes32(uint256(1_004)));
        PoolId secondPool = PoolId.wrap(bytes32(uint256(1_005)));
        PoolId tokenPool = PoolId.wrap(bytes32(uint256(1_006)));
        Currency nativeCurrency = Currency.wrap(address(0));
        Currency tokenCurrency = Currency.wrap(address(0xCAFE));
        router.configure(firstPool, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.configure(
            secondPool, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000
        );
        router.configure(tokenPool, address(creator), address(treasury), address(community), 10_000, 0, 0, 0);
        router.route{value: 1_000}(firstPool, nativeCurrency, 1_000);
        router.route{value: 2_000}(secondPool, nativeCurrency, 2_000);
        router.route(tokenPool, tokenCurrency, 3_000);
        require(router.claimable(firstPool, address(creator), nativeCurrency) == 400, "POOL_ONE_NATIVE");
        require(router.claimable(secondPool, address(creator), nativeCurrency) == 800, "POOL_TWO_NATIVE");
        require(router.claimable(tokenPool, address(creator), tokenCurrency) == 3_000, "TOKEN_CURRENCY");
        require(router.claimable(firstPool, address(creator), tokenCurrency) == 0, "CROSS_POOL_TOKEN_LEAK");
    }

    function testRepeatedProcessClaimCyclesConserveAllValue() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_007)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        uint256 total;
        vm.deal(address(this), 100_000);
        for (uint256 i = 1; i <= 10; ++i) {
            uint256 gross = i * 100;
            router.route{value: gross}(poolId, currency, gross);
            total += gross;
            creator.claim(router, poolId, currency);
            treasury.claim(router, poolId, currency);
            community.claim(router, poolId, currency);
            require(router.claimable(poolId, address(creator), currency) == 0, "CREATOR_CLAIMABLE_REMAINS");
            require(router.claimable(poolId, address(treasury), currency) == 0, "TREASURY_CLAIMABLE_REMAINS");
            require(router.claimable(poolId, address(community), currency) == 0, "COMMUNITY_CLAIMABLE_REMAINS");
        }
        uint256 distributed = address(creator).balance + address(treasury).balance + address(community).balance
            + vault.pendingLiquidity(poolId, currency);
        require(distributed == total, "REPEATED_CYCLES_NOT_CONSERVED");
    }

    function testFeeProcessingMakesNoExternalRecipientCalls() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        AdversarialReceiver creator = new AdversarialReceiver(address(this));
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault) =
            deployer.deploy(IPoolManager(address(manager)), address(treasury));

        vm.deal(address(this), 3 ether);
        SplitFactory.LaunchParams memory launchParams = SplitFactory.LaunchParams({
            name: "Adversarial Recipient",
            symbol: "ATTACK",
            tokenSeedAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            treasuryBps: 2_000,
            communityBps: 1_000,
            community: address(community),
            salt: keccak256("adversarial-recipient")
        });
        bytes memory launchResult =
            creator.execute{value: 1 ether}(address(factory), abi.encodeCall(factory.launch, (launchParams)));
        (address tokenAddress, PoolId poolId) = abi.decode(launchResult, (address, PoolId));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        creator.configureAttacks(
            address(hook),
            abi.encodeCall(hook.flush, (poolId, key.currency0)),
            address(router),
            abi.encodeCall(router.route, (poolId, key.currency0, uint256(1))),
            abi.encodeCall(
                router.configure, (poolId, address(creator), address(treasury), address(community), 10_000, 0, 0, 0)
            ),
            512
        );

        activeManager = IPoolManager(address(manager));
        activeZeroForOne = true;
        vm.deal(address(this), 1 ether);
        manager.unlock(abi.encode(key, int256(1e15)));
        uint256 accruedBefore = hook.accrued(poolId, key.currency0);
        require(accruedBefore != 0, "NO_NATIVE_INPUT_FEE");

        hook.flush(poolId, key.currency0);
        require(
            router.claimable(poolId, address(creator), key.currency0) == accruedBefore * 4_000 / 10_000,
            "CREATOR_ALLOCATION_MISMATCH"
        );
        require(creator.received() == 0, "PROCESSING_PAID_CREATOR_DIRECTLY");
        require(creator.fallbackWork() == 0, "PROCESSING_RAN_RECIPIENT_CALLBACK");
        require(!creator.hookReentrySucceeded() && !creator.nestedRouteSucceeded(), "RECIPIENT_CALLBACK_RAN");
        require(!creator.privilegedCallSucceeded(), "RECIPIENT_CHANGED_CONFIGURATION");
        require(hook.accrued(poolId, key.currency0) == 0, "ACCRUAL_NOT_ROUTED");
        uint256 expectedVaultAmount = accruedBefore - accruedBefore * 4_000 / 10_000 - accruedBefore * 2_000 / 10_000
            - accruedBefore * 1_000 / 10_000;
        require(vault.pendingLiquidity(poolId, key.currency0) == expectedVaultAmount, "VAULT_SPLIT");
    }

    function testPermanentlyRevertingCreatorCanNoLongerBlockFlush() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        AdversarialReceiver creator = new AdversarialReceiver(address(this));
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook, SplitFeeRouter router,) =
            deployer.deploy(IPoolManager(address(manager)), address(treasury));

        vm.deal(address(this), 3 ether);
        SplitFactory.LaunchParams memory launchParams = SplitFactory.LaunchParams({
            name: "Reverting Recipient",
            symbol: "REVERT",
            tokenSeedAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            treasuryBps: 2_000,
            communityBps: 1_000,
            community: address(community),
            salt: keccak256("permanently-reverting-recipient")
        });
        bytes memory launchResult =
            creator.execute{value: 1 ether}(address(factory), abi.encodeCall(factory.launch, (launchParams)));
        (address tokenAddress, PoolId poolId) = abi.decode(launchResult, (address, PoolId));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        creator.permanentlyRejectNative();
        activeManager = IPoolManager(address(manager));
        activeZeroForOne = true;
        vm.deal(address(this), 1 ether);
        manager.unlock(abi.encode(key, int256(1e15)));
        uint256 accruedBefore = hook.accrued(poolId, key.currency0);
        require(accruedBefore != 0 && creator.isPermanentlyRejecting(), "BAD_REVERTING_FIXTURE");

        hook.flush(poolId, key.currency0);
        require(hook.accrued(poolId, key.currency0) == 0, "FLUSH_BLOCKED");
        require(
            router.claimable(poolId, address(creator), key.currency0) == accruedBefore * 4_000 / 10_000,
            "CREATOR_NOT_ALLOCATED"
        );
        require(
            router.claimable(poolId, address(community), key.currency0) == accruedBefore / 10, "COMMUNITY_NOT_ALLOCATED"
        );
    }

    function testFuzzRouterConservesEveryWei(
        uint16 creatorSeed,
        uint16 liquiditySeed,
        uint16 treasurySeed,
        uint64 grossSeed
    ) external {
        uint16 creatorBps = creatorSeed % 10_001;
        uint16 remainingAfterCreator = uint16(10_000 - creatorBps);
        uint16 liquidityBps = remainingAfterCreator == 0 ? 0 : liquiditySeed % (remainingAfterCreator + 1);
        uint16 remainingAfterLiquidity = remainingAfterCreator - liquidityBps;
        uint16 treasuryBps = remainingAfterLiquidity == 0 ? 0 : treasurySeed % (remainingAfterLiquidity + 1);
        uint16 communityBps = remainingAfterLiquidity - treasuryBps;
        uint256 gross = uint256(grossSeed) + 1;

        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router =
            new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        PoolId poolId = PoolId.wrap(keccak256(abi.encode(creatorSeed, liquiditySeed, treasurySeed, grossSeed)));
        router.configure(
            poolId,
            address(creator),
            address(treasury),
            address(community),
            creatorBps,
            liquidityBps,
            treasuryBps,
            communityBps
        );
        vm.deal(address(this), gross);
        router.route{value: gross}(poolId, Currency.wrap(address(0)), gross);

        Currency currency = Currency.wrap(address(0));
        uint256 routed = router.totalRecipientAllocated(poolId, currency) + vault.pendingLiquidity(poolId, currency);
        require(routed == gross, "ROUTER_NOT_CONSERVING");
    }

    function testHookAccruesOnePercentOfExactOutputInputAndFlushes() external {
        MockPoolManager manager = new MockPoolManager();
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xCAFE)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key);
        vm.deal(address(manager), 100);
        SwapParams memory params = SwapParams(true, 10_000, 0x1000000000000000000000000);
        // Exact-output oneForZero? For zeroForOne exact output, currency0 is input (unspecified).
        BalanceDelta delta = toBalanceDelta(5_000, -4_900);
        vm.prank(address(manager));
        (bytes4 selector, int128 feeDelta) = hook.afterSwap(address(this), key, params, delta, "");
        require(selector == hook.afterSwap.selector, "BAD_SELECTOR");
        require(feeDelta == 50, "BAD_FEE_DELTA");
        require(hook.accrued(key.toId(), key.currency0) == 50, "NOT_ACCRUED");
        hook.flush(key.toId(), key.currency0);
        require(routedAmount == 50 && routedValue == 50, "NOT_ROUTED");
        require(hook.accrued(key.toId(), key.currency0) == 0, "NOT_CLEARED");
    }

    function testHookPermissionBitsAreExact() external {
        MockPoolManager manager = new MockPoolManager();
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        require(uint160(address(hook)) & 0x3fff == 0x44, "WRONG_PERMISSION_BITS");
    }

    function testFeeRoundsDownBelow100RawUnitsAndChargesOneAt100() external {
        MockPoolManager manager = new MockPoolManager();
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xCAFE)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key);
        vm.deal(address(manager), 1);
        SwapParams memory exactOutput = SwapParams(true, 100, 0x1000000000000000000000000);
        vm.prank(address(manager));
        (, int128 fee99) = hook.afterSwap(address(this), key, exactOutput, toBalanceDelta(99, -1), "");
        require(fee99 == 0 && hook.accrued(key.toId(), key.currency0) == 0, "SUBUNIT_FEE_NOT_FLOORED");
        vm.prank(address(manager));
        (, int128 fee100) = hook.afterSwap(address(this), key, exactOutput, toBalanceDelta(100, -1), "");
        require(fee100 == 1 && hook.accrued(key.toId(), key.currency0) == 1, "100_UNIT_BOUNDARY");
    }

    function testSeedPositionIsCreatedUnderVaultCustodyOnRealPoolManager() external {
        PoolManager manager = new PoolManager(address(this));
        SplitLiquidityVault vault =
            new SplitLiquidityVault(address(this), address(this), IPoolManager(address(manager)));
        SplitToken token = new SplitToken("Vault Seed", "VSEED", 10_000 ether, address(this));
        require(token.transfer(address(vault), 1 ether), "SEED_TRANSFER");
        vm.deal(address(this), 1 ether);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, uint160(1 << 96));
        vault.registerPool(key.toId(), key.currency0, key.currency1);
        bytes32 salt = keccak256("vault-position");
        vault.seedPosition{value: 1 ether}(key, uint160(1 << 96), 1 ether, 1 ether, salt);

        PoolId poolId = key.toId();
        uint128 vaultLiquidity = vault.positionLiquidity(poolId);
        uint128 pmLiquidity = StateLibrary.getPositionLiquidity(
            IPoolManager(address(manager)), poolId, Position.calculatePositionKey(address(vault), -887220, 887220, salt)
        );
        require(vaultLiquidity != 0 && pmLiquidity == vaultLiquidity, "VAULT_NOT_POSITION_OWNER");
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 0, "SEED_WRONGLY_PENDING");
        PositionStealer creator = new PositionStealer(IPoolManager(address(manager)));
        PositionStealer arbitraryUser = new PositionStealer(IPoolManager(address(manager)));
        require(!creator.attemptRemoval(key, -887220, 887220, salt, vaultLiquidity), "CREATOR_REMOVED_VAULT_POSITION");
        require(
            !arbitraryUser.attemptRemoval(key, -887220, 887220, salt, vaultLiquidity),
            "ARBITRARY_USER_REMOVED_VAULT_POSITION"
        );
        (bool secondSeed,) = address(vault).call{value: 1 ether}(
            abi.encodeCall(vault.seedPosition, (key, uint160(1 << 96), 1 ether, 1 ether, keccak256("second-seed")))
        );
        require(!secondSeed, "FACTORY_RESEEDED_OR_REPLACED_POSITION");

        (bool removed,) =
            address(vault).call(abi.encodeWithSignature("removeLiquidity(bytes32,uint256)", PoolId.unwrap(poolId), 1));
        require(!removed, "WITHDRAWAL_PATH_EXISTS");
        bytes4[7] memory forbiddenSelectors = [
            bytes4(keccak256("withdraw(bytes32,address,uint256)")),
            bytes4(keccak256("transferPosition(bytes32,address)")),
            bytes4(keccak256("collect(bytes32,address)")),
            bytes4(keccak256("setPositionOwner(bytes32,address)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
            bytes4(keccak256("rescueToken(address,address,uint256)"))
        ];
        for (uint256 i; i < forbiddenSelectors.length; ++i) {
            (bool seized,) = address(vault).call(abi.encodeWithSelector(forbiddenSelectors[i], address(0xBEEF), 1));
            require(!seized, "VAULT_EXPOSES_CUSTODY_ESCAPE");
        }
        uint128 remainingPosition = StateLibrary.getPositionLiquidity(
            IPoolManager(address(manager)), poolId, Position.calculatePositionKey(address(vault), -887220, 887220, salt)
        );
        require(remainingPosition == vaultLiquidity, "POSITION_CHANGED_AFTER_ATTACKS");
    }

    function testRealV4ExactInputSwapChargesOnePercentAndRoutesIt() external {
        PoolManager manager = new PoolManager(address(this));
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        SplitLiquidityVault vault =
            new SplitLiquidityVault(address(this), address(this), IPoolManager(address(manager)));
        SplitToken token = new SplitToken("Swap Test", "SWAP", 10_000 ether, address(this));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key);
        vault.registerPool(key.toId(), key.currency0, key.currency1);
        uint160 initialSqrtPrice = uint160(1 << 96);
        manager.initialize(key, initialSqrtPrice);
        require(token.transfer(address(vault), 100 ether), "SEED_TRANSFER");
        vm.deal(address(this), 100 ether);
        vault.seedPosition{value: 100 ether}(key, initialSqrtPrice, 100 ether, 100 ether, keccak256("swap-seed"));
        vm.deal(address(this), 1 ether);

        uint256 amountIn = 1e15;
        uint256 tokenBalanceBeforeSwap = token.balanceOf(address(this));
        uint256 nativeBalanceBeforeSwap = address(this).balance;
        activeManager = IPoolManager(address(manager));
        manager.unlock(abi.encode(key, -SafeCast.toInt256(amountIn)));
        require(lastSwapOutput > 0, "NO_OUTPUT");
        require(token.balanceOf(address(this)) - tokenBalanceBeforeSwap == lastSwapOutput, "TRADER_TOKEN_BALANCE");
        require(nativeBalanceBeforeSwap - address(this).balance == amountIn, "TRADER_NATIVE_INPUT");
        uint256 beforeRouted = routedAmount;
        hook.flush(key.toId(), key.currency1);
        uint256 fee = routedAmount - beforeRouted;
        require(fee == lastSwapOutput / 99, "OUTPUT_FEE_BASIS_MISMATCH");
        require(routedCurrency == key.currency1 && routedValue == 0, "WRONG_FEE_CURRENCY");
        require(hook.accrued(key.toId(), key.currency1) == 0, "ACCRUAL_NOT_CLEARED");
    }

    function testRealV4ExactOutputChargesFeeInInputCurrency() external {
        PoolManager manager = new PoolManager(address(this));
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        SplitLiquidityVault vault =
            new SplitLiquidityVault(address(this), address(this), IPoolManager(address(manager)));
        SplitToken token = new SplitToken("Exact Output", "EXOUT", 10_000 ether, address(this));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key);
        vault.registerPool(key.toId(), key.currency0, key.currency1);
        uint160 initialSqrtPrice = uint160(1 << 96);
        manager.initialize(key, initialSqrtPrice);
        require(token.transfer(address(vault), 100 ether), "SEED_TRANSFER");
        vm.deal(address(this), 100 ether);
        vault.seedPosition{value: 100 ether}(
            key, initialSqrtPrice, 100 ether, 100 ether, keccak256("exact-output-seed")
        );
        vm.deal(address(this), 1 ether);

        uint256 tokenBalanceBeforeSwap = token.balanceOf(address(this));
        uint256 nativeBalanceBeforeSwap = address(this).balance;
        activeManager = IPoolManager(address(manager));
        manager.unlock(abi.encode(key, int256(1e15)));
        require(lastSwapOutput == 1e15, "EXACT_OUTPUT_CHANGED");
        require(
            token.balanceOf(address(this)) - tokenBalanceBeforeSwap == lastSwapOutput, "EXACT_OUTPUT_TRADER_BALANCE"
        );
        require(nativeBalanceBeforeSwap - address(this).balance == lastSwapInput, "EXACT_OUTPUT_NATIVE_INPUT");
        hook.flush(key.toId(), key.currency0);
        require(routedAmount > 0 && routedValue == routedAmount, "INPUT_FEE_NOT_ROUTED");
        require(routedCurrency == key.currency0, "FEE_NOT_IN_INPUT_CURRENCY");
        require(routedAmount == (lastSwapInput - routedAmount) / 100, "INPUT_FEE_NOT_ONE_PERCENT");
    }

    function testRealV4OneForZeroExactInputChargesInNativeOutput() external {
        (PoolManager manager, SplitHook hook, SplitLiquidityVault vault, SplitToken token, PoolKey memory key) =
            _newHookedPool("one-for-zero-in");
        require(token.transfer(address(vault), 100 ether), "SEED_TRANSFER");
        vm.deal(address(this), 100 ether);
        vault.seedPosition{value: 100 ether}(key, uint160(1 << 96), 100 ether, 100 ether, keccak256("one-for-zero-in"));
        uint256 nativeBalanceBeforeSwap = address(this).balance;
        uint256 tokenBalanceBeforeSwap = token.balanceOf(address(this));
        activeManager = IPoolManager(address(manager));
        activeZeroForOne = false;
        manager.unlock(abi.encode(key, -int256(1e15)));
        require(lastSwapOutput > 0 && lastSwapInput == 1e15, "BAD_ONE_FOR_ZERO_SWAP");
        require(address(this).balance - nativeBalanceBeforeSwap == lastSwapOutput, "NATIVE_TRADER_BALANCE");
        require(tokenBalanceBeforeSwap - token.balanceOf(address(this)) == lastSwapInput, "ONE_FOR_ZERO_TOKEN_INPUT");
        hook.flush(key.toId(), key.currency0);
        require(routedCurrency == key.currency0 && routedValue == routedAmount, "NATIVE_OUTPUT_FEE_NOT_ROUTED");
        require(routedAmount == lastSwapOutput / 99, "ONE_FOR_ZERO_INPUT_FEE_BASIS");
    }

    function testRealV4OneForZeroExactOutputChargesInTokenInput() external {
        (PoolManager manager, SplitHook hook, SplitLiquidityVault vault, SplitToken token, PoolKey memory key) =
            _newHookedPool("one-for-zero-out");
        require(token.transfer(address(vault), 100 ether), "SEED_TRANSFER");
        vm.deal(address(this), 100 ether);
        vault.seedPosition{value: 100 ether}(key, uint160(1 << 96), 100 ether, 100 ether, keccak256("one-for-zero-out"));
        vm.deal(address(this), 1 ether);
        uint256 nativeBalanceBeforeSwap = address(this).balance;
        uint256 tokenBalanceBeforeSwap = token.balanceOf(address(this));
        activeManager = IPoolManager(address(manager));
        activeZeroForOne = false;
        manager.unlock(abi.encode(key, int256(1e15)));
        require(lastSwapOutput == 1e15 && lastSwapInput > 0, "BAD_ONE_FOR_ZERO_EXACT_OUTPUT");
        require(address(this).balance - nativeBalanceBeforeSwap == lastSwapOutput, "EXACT_OUTPUT_NATIVE_BALANCE");
        require(tokenBalanceBeforeSwap - token.balanceOf(address(this)) == lastSwapInput, "EXACT_OUTPUT_TOKEN_INPUT");
        hook.flush(key.toId(), key.currency1);
        require(routedCurrency == key.currency1 && routedValue == 0, "TOKEN_INPUT_FEE_NOT_ROUTED");
        require(routedAmount == (lastSwapInput - routedAmount) / 100, "ONE_FOR_ZERO_EXACT_OUTPUT_FEE_BASIS");
    }

    function testTenSwapsBeforeFlushAndRepeatedFlushDoNotDoubleRoute() external {
        (PoolManager manager, SplitHook hook, SplitLiquidityVault vault, SplitToken token, PoolKey memory key) =
            _newHookedPool("multi-swap");
        require(token.transfer(address(vault), 100 ether), "SEED_TRANSFER");
        vm.deal(address(this), 100 ether);
        vault.seedPosition{value: 100 ether}(key, uint160(1 << 96), 100 ether, 100 ether, keccak256("multi-swap"));
        vm.deal(address(this), 1 ether);
        activeManager = IPoolManager(address(manager));
        for (uint256 i; i < 10; ++i) {
            manager.unlock(abi.encode(key, -int256(1e13)));
        }
        uint256 firstAccrued = hook.accrued(key.toId(), key.currency1);
        require(firstAccrued > 0 && routedTotal == 0, "FEES_ROUTED_DURING_SWAP");
        hook.flush(key.toId(), key.currency1);
        require(routedTotal == firstAccrued, "FIRST_FLUSH_MISMATCH");
        require(hook.accrued(key.toId(), key.currency1) == 0, "FIRST_FLUSH_NOT_CLEARED");

        manager.unlock(abi.encode(key, -int256(1e13)));
        uint256 secondAccrued = hook.accrued(key.toId(), key.currency1);
        hook.flush(key.toId(), key.currency1);
        require(routedTotal == firstAccrued + secondAccrued, "REPEATED_FLUSH_DOUBLE_COUNT");
        require(hook.accrued(key.toId(), key.currency1) == 0, "SECOND_FLUSH_NOT_CLEARED");
    }

    function testFactoryLaunchTradeAndFourWayDistributionEndToEnd() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        NativeReceiver communityB = new NativeReceiver();
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault) =
            deployer.deploy(IPoolManager(address(manager)), address(treasury));
        vm.deal(address(this), 3 ether);
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "SPLIT End-to-End",
            symbol: "SPLITX",
            tokenSeedAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            treasuryBps: 2_000,
            communityBps: 1_000,
            community: address(community),
            salt: keccak256("end-to-end")
        });
        (address tokenAddress, PoolId poolId) = factory.launch{value: 1 ether}(params);
        SplitToken token = SplitToken(tokenAddress);
        require(factory.launchedToken(tokenAddress), "NOT_LAUNCHED");
        require(vault.positionLiquidity(poolId) != 0, "NO_SEED_POSITION");
        require(token.balanceOf(address(this)) == token.totalSupply() - 1 ether, "CREATOR_SUPPLY");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        params.name = "SPLIT Isolated Project";
        params.symbol = "SPLITY";
        params.community = address(communityB);
        params.creatorBps = 0;
        params.liquidityBps = 0;
        params.treasuryBps = 0;
        params.communityBps = 10_000;
        (address tokenAddressB, PoolId poolIdB) = factory.launch{value: 1 ether}(params);
        SplitToken tokenB = SplitToken(tokenAddressB);
        PoolKey memory keyB = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddressB),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        activeManager = IPoolManager(address(manager));
        manager.unlock(abi.encode(key, -int256(1e15)));
        manager.unlock(abi.encode(keyB, -int256(1e15)));
        uint256 fee = hook.accrued(poolId, key.currency1);
        uint256 feeB = hook.accrued(poolIdB, keyB.currency1);
        require(fee > 0 && feeB > 0, "NO_FEE_ACCRUED");
        hook.flush(poolId, key.currency1);
        uint256 creatorShare = fee * 4_000 / 10_000;
        uint256 treasuryShare = fee * 2_000 / 10_000;
        uint256 communityShare = fee * 1_000 / 10_000;
        uint256 liquidityShare = fee - creatorShare - treasuryShare - communityShare;
        require(router.claimable(poolId, address(this), key.currency1) == creatorShare, "CREATOR_SPLIT");
        require(router.claimable(poolId, address(treasury), key.currency1) == treasuryShare, "TREASURY_SPLIT");
        require(router.claimable(poolId, address(community), key.currency1) == communityShare, "COMMUNITY_SPLIT");
        require(vault.pendingLiquidity(poolId, key.currency1) == liquidityShare, "LIQUIDITY_SPLIT");
        (address configuredCreator,,,,,,,) = router.splits(poolId);
        require(configuredCreator == address(this), "CONFIG_NOT_CREATOR");
        hook.flush(poolIdB, keyB.currency1);
        require(
            router.claimable(poolIdB, address(communityB), keyB.currency1) == feeB, "PROJECT_B_DID_NOT_RECEIVE_ITS_FEE"
        );
        require(
            token.balanceOf(address(communityB)) == 0 && tokenB.balanceOf(address(community)) == 0,
            "CROSS_PROJECT_FEE_LEAK"
        );
        require(vault.pendingLiquidity(poolIdB, keyB.currency1) == 0, "PROJECT_B_LIQUIDITY_CROSSED");
    }

    /// @notice Optional fork-only lifecycle. It never broadcasts and is explicitly skipped
    ///         unless both a read-only RPC URL and a pinned historical block are provided.
    function testRHMainnetPinnedForkLaunchSeedSwapAndFeeSettlement() external {
        if (!vm.envExists("RH_MAINNET_FORK_RPC_URL") || !vm.envExists("RH_MAINNET_FORK_BLOCK")) {
            vm.skip(true);
            return;
        }
        string memory rpcUrl = vm.envString("RH_MAINNET_FORK_RPC_URL");
        uint256 forkBlock = vm.envUint("RH_MAINNET_FORK_BLOCK");
        if (bytes(rpcUrl).length == 0 || forkBlock == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl, forkBlock);
        require(block.chainid == 4663, "NOT_RH_MAINNET_FORK");

        IPoolManager manager = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        require(address(manager).code.length != 0, "OFFICIAL_POOL_MANAGER_MISSING");
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault) =
            deployer.deploy(manager, address(treasury));
        forkRouter = router;
        forkVault = vault;

        vm.deal(address(this), 3 ether);
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "SPLIT RH Fork Test",
            symbol: "RHFORK",
            tokenSeedAmount: 1 ether,
            creatorBps: 10_000,
            liquidityBps: 0,
            treasuryBps: 0,
            communityBps: 0,
            community: address(community),
            salt: keccak256("rh-mainnet-pinned-fork")
        });
        (address tokenAddress, PoolId poolId) = factory.launch{value: 1 ether}(params);
        require(hook.registeredPool(poolId), "POOL_NOT_REGISTERED");
        require(vault.positionLiquidity(poolId) != 0, "FORK_SEED_POSITION_MISSING");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        _runObservedForkSwap(manager, hook, key, poolId, true, -int256(1e15), key.currency1);
        _runObservedForkSwap(manager, hook, key, poolId, true, int256(1e15), key.currency0);
        _runObservedForkSwap(manager, hook, key, poolId, false, -int256(1e15), key.currency0);
        _runObservedForkSwap(manager, hook, key, poolId, false, int256(1e15), key.currency1);
    }

    /// @dev Captures the actual trader balance deltas around PoolManager.swap, derives the
    ///      pre-hook raw swap deltas by adding/subtracting the observed accrued fee, then
    ///      checks the router's claim-backing balance and allocation ledger independently of events.
    function _runObservedForkSwap(
        IPoolManager manager,
        SplitHook hook,
        PoolKey memory key,
        PoolId poolId,
        bool zeroForOne,
        int256 amountSpecified,
        Currency expectedFeeCurrency
    ) private {
        bool exactOutput = amountSpecified > 0;
        SplitToken token = SplitToken(Currency.unwrap(key.currency1));
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = token.balanceOf(address(this));
        lastSwapInput = 0;
        lastSwapOutput = 0;
        activeManager = manager;
        activeZeroForOne = zeroForOne;
        manager.unlock(abi.encode(key, amountSpecified));

        uint256 traderInput =
            zeroForOne ? nativeBefore - address(this).balance : tokenBefore - token.balanceOf(address(this));
        uint256 traderOutput =
            zeroForOne ? token.balanceOf(address(this)) - tokenBefore : address(this).balance - nativeBefore;
        uint256 fee = hook.accrued(poolId, expectedFeeCurrency);
        require(fee != 0, "FORK_FEE_NOT_ACCRUED");
        // Output-fee swaps expose net output to the trader; input-fee swaps expose
        // gross input (raw pool input plus the SPLIT fee).
        uint256 rawTradedAmount = exactOutput ? traderInput - fee : traderOutput + fee;
        require(fee == rawTradedAmount / 100, "FORK_FEE_NOT_ONE_PERCENT");
        require(
            (zeroForOne && expectedFeeCurrency == (exactOutput ? key.currency0 : key.currency1))
                || (!zeroForOne && expectedFeeCurrency == (exactOutput ? key.currency1 : key.currency0)),
            "FORK_WRONG_FEE_CURRENCY"
        );

        int256 rawDelta0;
        int256 rawDelta1;
        int256 traderDelta0;
        int256 traderDelta1;
        if (zeroForOne) {
            // PoolManager balance deltas are signed int128 values, so observed amounts fit int256.
            rawDelta0 = -SafeCast.toInt256(exactOutput ? rawTradedAmount : traderInput);
            // PoolManager balance deltas are signed int128 values, so observed amounts fit int256.
            rawDelta1 = SafeCast.toInt256(exactOutput ? traderOutput : rawTradedAmount);
            // These values are magnitudes of PoolManager's int128 balance deltas.
            traderDelta0 = -SafeCast.toInt256(traderInput);
            // These values are magnitudes of PoolManager's int128 balance deltas.
            traderDelta1 = SafeCast.toInt256(traderOutput);
        } else {
            // PoolManager balance deltas are signed int128 values, so observed amounts fit int256.
            rawDelta0 = SafeCast.toInt256(exactOutput ? traderOutput : rawTradedAmount);
            // PoolManager balance deltas are signed int128 values, so observed amounts fit int256.
            rawDelta1 = -SafeCast.toInt256(exactOutput ? rawTradedAmount : traderInput);
            // These values are magnitudes of PoolManager's int128 balance deltas.
            traderDelta0 = SafeCast.toInt256(traderOutput);
            // These values are magnitudes of PoolManager's int128 balance deltas.
            traderDelta1 = -SafeCast.toInt256(traderInput);
        }
        // SplitHook rejects fees above int128.max before returning its callback delta.
        emit ForkSwapMeasured(
            exactOutput, zeroForOne, rawDelta0, rawDelta1, SafeCast.toInt128(fee), traderDelta0, traderDelta1, fee
        );

        _flushForkFee(hook, key, poolId, expectedFeeCurrency, fee);
    }

    function _flushForkFee(SplitHook hook, PoolKey memory key, PoolId poolId, Currency currency, uint256 fee) private {
        SplitFeeRouter router = forkRouter;
        SplitLiquidityVault vault = forkVault;
        uint256 routerBalanceBefore = currency == key.currency0
            ? address(router).balance
            : SplitToken(Currency.unwrap(key.currency1)).balanceOf(address(router));
        uint256 allocationsBefore = router.totalRecipientAllocated(poolId, currency);
        uint256 liquidityBefore = vault.pendingLiquidity(poolId, currency);
        hook.flush(poolId, currency);
        uint256 routerBalanceAfter = currency == key.currency0
            ? address(router).balance
            : SplitToken(Currency.unwrap(key.currency1)).balanceOf(address(router));
        uint256 recipientAllocation = router.totalRecipientAllocated(poolId, currency) - allocationsBefore;
        uint256 liquidityCredit = vault.pendingLiquidity(poolId, currency) - liquidityBefore;
        require(routerBalanceAfter - routerBalanceBefore == recipientAllocation, "FORK_CLAIM_BACKING_MISMATCH");
        require(recipientAllocation + liquidityCredit == fee, "FORK_ROUTING_NOT_CONSERVED");
        require(hook.accrued(poolId, currency) == 0, "FORK_ACCRUAL_NOT_SETTLED");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(activeManager), "UNEXPECTED_UNLOCK");
        (PoolKey memory key, int256 amountSpecified) = abi.decode(data, (PoolKey, int256));
        SwapParams memory params = SwapParams({
            zeroForOne: activeZeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: activeZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        BalanceDelta delta = activeManager.swap(key, params, "");
        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        if (amount0 < 0) {
            // amount0 is int128 and checked negative; promotion then negation fits uint256.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 nativeOwed = uint256(-int256(amount0));
            if (activeZeroForOne) lastSwapInput = nativeOwed;
            activeManager.settle{value: nativeOwed}();
        }
        if (amount1 < 0) {
            // amount1 is int128 and checked negative; promotion then negation fits uint256.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 tokenOwed = uint256(-int256(amount1));
            if (!activeZeroForOne) lastSwapInput = tokenOwed;
            activeManager.sync(key.currency1);
            key.currency1.transfer(address(activeManager), tokenOwed);
            activeManager.settle();
        }
        if (amount1 > 0) {
            // Positive int128 amount1 necessarily fits uint128.
            uint256 tokenOutput = SafeCast.toUint128(amount1);
            if (activeZeroForOne) lastSwapOutput = tokenOutput;
            activeManager.take(key.currency1, address(this), tokenOutput);
        }
        if (amount0 > 0) {
            // Positive int128 amount0 necessarily fits uint128.
            uint256 nativeOutput = SafeCast.toUint128(amount0);
            if (!activeZeroForOne) lastSwapOutput = nativeOutput;
            activeManager.take(key.currency0, address(this), nativeOutput);
        }
        return "";
    }

    function _newHookedPool(string memory tokenName)
        private
        returns (PoolManager manager, SplitHook hook, SplitLiquidityVault vault, SplitToken token, PoolKey memory key)
    {
        manager = new PoolManager(address(this));
        hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        vault = new SplitLiquidityVault(address(this), address(this), IPoolManager(address(manager)));
        token = new SplitToken(tokenName, "DIRECTION", 10_000 ether, address(this));
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        hook.registerPool(key);
        vault.registerPool(key.toId(), key.currency0, key.currency1);
        manager.initialize(key, uint160(1 << 96));
    }

    function _deployHook(IPoolManager manager, address factory, address router) private returns (SplitHook deployed) {
        bytes memory initCode = abi.encodePacked(
            type(SplitHook).creationCode, abi.encode(manager, factory, SplitFeeRouter(payable(router)))
        );
        bytes32 initCodeHash = keccak256(initCode);
        for (uint256 i; i < 65_536; ++i) {
            bytes32 salt = bytes32(i);
            address predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
            if (uint160(predicted) & 0x3fff != 0x44) continue;
            address created;
            assembly ("memory-safe") {
                created := create2(0, add(initCode, 0x20), mload(initCode), salt)
            }
            require(created == predicted && created != address(0), "HOOK_DEPLOY_FAILED");
            return SplitHook(payable(created));
        }
        revert("HOOK_SALT_NOT_FOUND");
    }
}

contract SplitAccountingHandler {
    SplitFeeRouter public immutable router;
    MockLiquidityVault public immutable vault;
    NativeReceiver public immutable creator;
    NativeReceiver public immutable treasury;
    NativeReceiver public immutable community;
    PoolId public immutable poolId;
    uint256 public totalRouted;
    uint256 public totalAccrued;
    uint256 public currentAccrual;

    constructor() {
        creator = new NativeReceiver();
        treasury = new NativeReceiver();
        community = new NativeReceiver();
        vault = new MockLiquidityVault();
        router = new SplitFeeRouter(address(this), address(this), SplitLiquidityVault(payable(address(vault))));
        poolId = PoolId.wrap(keccak256("split-router-invariant"));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
    }

    receive() external payable {}

    function routeRandom(uint64 rawAmount) external {
        uint256 amount = uint256(rawAmount) + 1;
        if (address(this).balance < amount) return;
        totalAccrued += amount;
        currentAccrual += amount;
    }

    function processAccrued(uint64 amountSeed) external {
        uint256 amount = currentAccrual == 0 ? 0 : uint256(amountSeed) % (currentAccrual + 1);
        if (amount == 0) return;
        currentAccrual -= amount;
        router.route{value: amount}(poolId, Currency.wrap(address(0)), amount);
        totalRouted += amount;
    }

    function claimRandom(uint8 recipientSeed) external {
        NativeReceiver recipient = recipientSeed % 3 == 0 ? creator : recipientSeed % 3 == 1 ? treasury : community;
        try recipient.claim(router, poolId, Currency.wrap(address(0))) {} catch {}
    }
}

contract SplitAccountingInvariant {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SplitAccountingHandler private handler;
    address[] private targets;

    function setUp() external {
        handler = new SplitAccountingHandler();
        vm.deal(address(handler), 1e30);
        targets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    function invariant_RoutingConservesAllValue() external view {
        SplitFeeRouter router = handler.router();
        PoolId poolId = handler.poolId();
        Currency currency = Currency.wrap(address(0));
        uint256 processed =
            router.totalRecipientAllocated(poolId, currency) + handler.vault().pendingLiquidity(poolId, currency);
        require(handler.totalAccrued() == processed + handler.currentAccrual(), "ACCRUED_VALUE_CREATED_OR_LOST");
    }

    function invariant_AllocatedEqualsClaimedPlusClaimable() external view {
        SplitFeeRouter router = handler.router();
        PoolId poolId = handler.poolId();
        Currency currency = Currency.wrap(address(0));
        uint256 claimableTotal = router.claimable(poolId, address(handler.creator()), currency)
            + router.claimable(poolId, address(handler.treasury()), currency)
            + router.claimable(poolId, address(handler.community()), currency);
        require(
            router.totalRecipientAllocated(poolId, currency)
                == router.totalRecipientClaimed(poolId, currency) + claimableTotal,
            "RECIPIENT_ACCOUNTING_MISMATCH"
        );
    }

    function invariant_AllocationRemainsExactlyTenThousandBps() external view {
        (,,, uint16 creatorBps, uint16 liquidityBps, uint16 treasuryBps, uint16 communityBps, bool configured) =
            handler.router().splits(handler.poolId());
        require(configured, "NOT_CONFIGURED");
        require(uint256(creatorBps) + liquidityBps + treasuryBps + communityBps == 10_000, "BAD_BPS_TOTAL");
    }

    function invariant_VaultLedgerMatchesItsNativeBalance() external view {
        require(
            handler.vault().pendingLiquidity(handler.poolId(), Currency.wrap(address(0)))
                == address(handler.vault()).balance,
            "VAULT_LEDGER_MISMATCH"
        );
    }

    function invariant_FeesAccruedConserveProcessedAndUnprocessedAmounts() external view {
        require(
            handler.totalAccrued() == handler.totalRouted() + handler.currentAccrual(), "ACCRUAL_PROCESSING_MISMATCH"
        );
    }
}
