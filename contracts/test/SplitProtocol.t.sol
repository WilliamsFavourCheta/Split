// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SplitToken} from "../src/SplitToken.sol";
import {SplitHook} from "../src/SplitHook.sol";
import {SplitFeeRouter} from "../src/SplitFeeRouter.sol";
import {SplitLiquidityVault} from "../src/SplitLiquidityVault.sol";
import {SplitFactory} from "../src/SplitFactory.sol";
import {SplitSwapExecutor} from "../src/SplitSwapExecutor.sol";
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
import {SplitStackDeployer as ProductionSplitStackDeployer} from "../script/SplitStackDeployer.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert() external;
    function envExists(string calldata) external view returns (bool);
    function envString(string calldata) external view returns (string memory);
    function envUint(string calldata) external view returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function rollFork(uint256) external;
    function load(address, bytes32) external view returns (bytes32);
    function skip(bool) external;
}

interface ISplitV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

contract NativeReceiver {
    receive() external payable {}

    function claim(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claim(poolId, currency);
    }

    function claimProtocol(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claimProtocolFees(poolId, currency);
    }

    function claimProtocolLaunchFees(SplitFeeRouter router) external {
        router.claimProtocolLaunchFees();
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("REJECT_NATIVE");
    }

    function claim(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claim(poolId, currency);
    }

    function claimProtocol(SplitFeeRouter router, PoolId poolId, Currency currency) external {
        router.claimProtocolFees(poolId, currency);
    }

    function claimProtocolLaunchFees(SplitFeeRouter router) external {
        router.claimProtocolLaunchFees();
    }

    function launch(SplitFactory factory, SplitFactory.LaunchParams calldata params)
        external
        payable
        returns (address token, PoolId poolId)
    {
        return factory.launch{value: msg.value}(params);
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
        for (uint256 i; i < 262_144; ++i) {
            salt = bytes32(i);
            hookAddress =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
            if (uint160(hookAddress) & 0x3fff == 0x2044) {
                found = true;
                break;
            }
        }
        require(found, "HOOK_SALT_NOT_FOUND");

        vault = new SplitLiquidityVault(factoryAddress, routerAddress, manager);
        router = new SplitFeeRouter(factoryAddress, hookAddress, vault, treasury);
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
    bool private activeRemovalAttempt;

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
    event ForkClaimGas(
        address indexed recipient,
        address indexed currency,
        uint256 expectedAmount,
        uint256 claimableBefore,
        uint256 recipientBalanceBefore,
        uint256 gasUsed,
        uint256 claimableAfter,
        uint256 recipientBalanceAfter
    );
    event ForkRejectedClaimGas(address indexed recipient, address indexed currency, uint256 claimable, uint256 gasUsed);
    event ForkStackDeploymentGas(address indexed stackDeployer, uint256 helperCreateGas, uint256 stackCreationGas);

    function testProductionStackDeployerBindsConfigurationAndRejectsPreemption() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver intendedTreasury = new NativeReceiver();
        ProductionSplitStackDeployer deployer =
            new ProductionSplitStackDeployer(IPoolManager(address(manager)), address(intendedTreasury));
        require(deployer.authorizedDeployer() == address(this), "AUTHORIZED_DEPLOYER_NOT_BOUND");
        require(address(deployer.expectedPoolManager()) == address(manager), "MANAGER_NOT_BOUND");
        require(deployer.protocolTreasury() == address(intendedTreasury), "TREASURY_NOT_BOUND");

        bytes32 salt = _findProductionHookSalt(IPoolManager(address(manager)), address(deployer));
        vm.expectRevert();
        vm.prank(address(0xBEEF));
        deployer.deploy(salt);
        require(!deployer.deployed(), "UNAUTHORIZED_CALL_CONSUMED_DEPLOYMENT");

        (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault) = deployer.deploy(salt);
        require(factory.protocolTreasury() == address(intendedTreasury), "FACTORY_TREASURY_REPLACED");
        require(router.protocolTreasury() == address(intendedTreasury), "ROUTER_TREASURY_REPLACED");
        require(address(factory.poolManager()) == address(manager), "FACTORY_MANAGER_REPLACED");
        require(address(factory.hook()) == address(hook), "HOOK_ADDRESS_MISMATCH");
        require(address(factory.feeRouter()) == address(router), "ROUTER_ADDRESS_MISMATCH");
        require(address(factory.liquidityVault()) == address(vault), "VAULT_ADDRESS_MISMATCH");
        require(uint160(address(hook)) & 0x3fff == 0x2044, "HOOK_PERMISSION_BITS_MISMATCH");
        require(deployer.deployed(), "DEPLOYMENT_NOT_MARKED_COMPLETE");

        vm.expectRevert();
        deployer.deploy(salt);
    }

    function testProductionStackDeployerRejectsWrongConstructorConfiguration() external {
        PoolManager manager = new PoolManager(address(this));
        vm.expectRevert();
        new ProductionSplitStackDeployer(IPoolManager(address(manager)), address(0));
        vm.expectRevert();
        new ProductionSplitStackDeployer(IPoolManager(address(0x1234)), address(this));
    }

    function testUnregisteredAlternatePoolCannotAccrueSPLITFees() external {
        PoolManager manager = new PoolManager(address(this));
        SplitHook hook = _deployHook(IPoolManager(address(manager)), address(this), address(this));
        SplitToken token = new SplitToken("Alternate Venue", "ALT", 10_000 ether, address(this));
        PoolKey memory alternateKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 3_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId alternatePoolId = alternateKey.toId();
        require(!hook.registeredPool(alternatePoolId), "ALTERNATE_POOL_SHOULD_NOT_BE_REGISTERED");
        vm.expectRevert();
        vm.prank(address(manager));
        hook.afterSwap(
            address(this),
            alternateKey,
            SwapParams(true, -1_000, 0x1000000000000000000000000),
            toBalanceDelta(-1_000, 1_000),
            ""
        );
        require(hook.accrued(alternatePoolId, Currency.wrap(address(token))) == 0, "ALTERNATE_POOL_ACCRUED_FEE");
    }

    function testFutureSplitPoolCannotBePreinitializedBeforeFactoryLaunch() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook,,) = deployer.deploy(IPoolManager(address(manager)), address(treasury));

        // The factory's first CREATE is the token. Predict it before any launch occurs.
        address predictedToken = _predictedCreateAddress(address(factory), 1);
        PoolKey memory intendedKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(predictedToken),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        uint160 initialPrice = uint160(1 << 96);
        address attacker = address(0xBEEF);

        // Exact predicted future key, initialized directly by an attacker: denied.
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(intendedKey, initialPrice);

        // Other key variants cannot borrow the same permission or bind a different PoolId.
        PoolKey memory arbitraryTokenKey = intendedKey;
        arbitraryTokenKey.currency1 = Currency.wrap(address(0xCAFE));
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(arbitraryTokenKey, initialPrice);

        PoolKey memory alteredFeeKey = intendedKey;
        alteredFeeKey.fee = 3_001;
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(alteredFeeKey, initialPrice);

        PoolKey memory alteredSpacingKey = intendedKey;
        alteredSpacingKey.tickSpacing = 61;
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(alteredSpacingKey, initialPrice);

        // Reverse ordering is invalid for native/token currencies, and must never initialize.
        PoolKey memory reversedKey = intendedKey;
        reversedKey.currency0 = Currency.wrap(predictedToken);
        reversedKey.currency1 = Currency.wrap(address(0));
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(reversedKey, initialPrice);

        require(!hook.registeredPool(intendedKey.toId()), "ATTACKER_REGISTERED_POOL");
        require(!hook.initializationAuthorized(intendedKey.toId()), "UNEXPECTED_STALE_AUTHORIZATION");

        vm.deal(address(this), 2 ether);
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "Authorized Launch",
            symbol: "AUTH",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(treasury),
            community: address(community),
            salt: keccak256("authorized-launch")
        });
        RevertingReceiver revertingCreator = new RevertingReceiver();
        vm.deal(address(this), 3 ether);
        vm.expectRevert();
        revertingCreator.launch{value: 1.000500000000000001 ether}(factory, params);
        require(!hook.registeredPool(intendedKey.toId()), "FAILED_LAUNCH_LEFT_POOL_REGISTERED");
        require(!hook.initializationAuthorized(intendedKey.toId()), "FAILED_LAUNCH_LEFT_STALE_AUTHORIZATION");
        require(!hook.initializedPool(intendedKey.toId()), "FAILED_LAUNCH_LEFT_POOL_INITIALIZED");
        require(!factory.launchedToken(predictedToken), "FAILED_LAUNCH_LEFT_TOKEN_MAPPING");

        (address launchedToken, PoolId poolId) = factory.launch{value: 1.0005 ether}(params);
        require(launchedToken == predictedToken, "CREATE_PREDICTION_CHANGED");
        require(hook.registeredPool(poolId), "AUTHORIZED_POOL_NOT_REGISTERED");
        require(hook.initializedPool(poolId), "POOL_INITIALIZATION_NOT_RECORDED");
        require(!hook.initializationAuthorized(poolId), "AUTHORIZATION_NOT_CONSUMED");
        require(factory.tokenForPool(poolId) == launchedToken, "FACTORY_POOL_MAPPING_MISSING");

        // The pool already exists and its authorization has been consumed; both paths fail.
        vm.expectRevert();
        vm.prank(attacker);
        manager.initialize(intendedKey, initialPrice);
        vm.expectRevert();
        vm.prank(attacker);
        hook.registerPool(intendedKey);
    }

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
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(123)));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        vm.deal(address(this), 10_000);
        router.route{value: 10_000}(poolId, Currency.wrap(address(0)), 10_000);

        require(router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 3_600, "CREATOR_SHARE");
        require(
            router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 1_800, "PROJECT_TREASURY_SHARE"
        );
        require(router.claimable(poolId, address(community), Currency.wrap(address(0))) == 900, "COMMUNITY_SHARE");
        require(router.protocolClaimable(poolId, Currency.wrap(address(0))) == 1_000, "PROTOCOL_SHARE");
        require(address(vault).balance == 2_700, "VAULT_SHARE");
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 2_700, "VAULT_ACCOUNTING");
        (address configuredCreator,,,,,,,) = router.splits(poolId);
        require(configuredCreator == address(creator), "CONFIG_NOT_IMMUTABLE");
    }

    function testGlobalProtocolTreasuryIsSeparateFromEachProjectTreasury() external {
        NativeReceiver protocolTreasury = new NativeReceiver();
        NativeReceiver projectTreasuryA = new NativeReceiver();
        NativeReceiver projectTreasuryB = new NativeReceiver();
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(protocolTreasury)
        );
        PoolId poolA = PoolId.wrap(bytes32(uint256(125)));
        PoolId poolB = PoolId.wrap(bytes32(uint256(126)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolA, address(creator), address(projectTreasuryA), address(community), 0, 0, 10_000, 0);
        router.configure(poolB, address(creator), address(projectTreasuryB), address(community), 0, 0, 10_000, 0);
        require(address(protocolTreasury) != address(projectTreasuryA), "GLOBAL_EQUALS_PROJECT_A");
        require(address(protocolTreasury) != address(projectTreasuryB), "GLOBAL_EQUALS_PROJECT_B");

        vm.deal(address(this), 200);
        router.route{value: 100}(poolA, currency, 100);
        router.route{value: 100}(poolB, currency, 100);

        require(router.protocolClaimable(poolA, currency) == 10, "POOL_A_GLOBAL_SHARE");
        require(router.protocolClaimable(poolB, currency) == 10, "POOL_B_GLOBAL_SHARE");
        require(router.claimable(poolA, address(projectTreasuryA), currency) == 90, "POOL_A_PROJECT_SHARE");
        require(router.claimable(poolB, address(projectTreasuryB), currency) == 90, "POOL_B_PROJECT_SHARE");
        require(router.claimable(poolA, address(protocolTreasury), currency) == 0, "GLOBAL_IN_PROJECT_LEDGER");
        require(router.claimable(poolB, address(protocolTreasury), currency) == 0, "GLOBAL_IN_OTHER_PROJECT_LEDGER");
        (address configuredA, address configuredProjectA,,,,,,) = router.splits(poolA);
        (address configuredB, address configuredProjectB,,,,,,) = router.splits(poolB);
        require(configuredA == address(creator) && configuredB == address(creator), "CREATOR_CONFIG");
        require(configuredProjectA == address(projectTreasuryA), "PROJECT_A_DESTINATION");
        require(configuredProjectB == address(projectTreasuryB), "PROJECT_B_DESTINATION");
    }

    function testRouterAssignsAllRoundingDustToVault() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(124)));
        router.configure(poolId, address(creator), address(treasury), address(community), 3_333, 0, 3_333, 3_334);
        vm.deal(address(this), 101);
        router.route{value: 101}(poolId, Currency.wrap(address(0)), 101);
        require(router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 30, "CREATOR_ROUNDING");
        require(
            router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 30, "PROJECT_TREASURY_ROUNDING"
        );
        require(router.claimable(poolId, address(community), Currency.wrap(address(0))) == 30, "COMMUNITY_ROUNDING");
        require(router.protocolClaimable(poolId, Currency.wrap(address(0))) == 10, "PROTOCOL_ROUNDING");
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 1, "DUST_NOT_TO_VAULT");
    }

    function testUneven3333_3333_3333_1SplitConservesGrossFee() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_234)));
        router.configure(poolId, address(creator), address(treasury), address(community), 3_333, 3_333, 3_333, 1);
        vm.deal(address(this), 10_000);
        router.route{value: 10_000}(poolId, Currency.wrap(address(0)), 10_000);

        require(
            router.claimable(poolId, address(creator), Currency.wrap(address(0))) == 2_999, "UNEQUAL_CREATOR_AMOUNT"
        );
        require(vault.pendingLiquidity(poolId, Currency.wrap(address(0))) == 3_002, "UNEQUAL_LIQUIDITY_AMOUNT");
        require(
            router.claimable(poolId, address(treasury), Currency.wrap(address(0))) == 2_999, "UNEQUAL_TREASURY_AMOUNT"
        );
        require(
            router.claimable(poolId, address(community), Currency.wrap(address(0))) == 0, "UNEQUAL_COMMUNITY_AMOUNT"
        );
        require(
            router.totalRecipientAllocated(poolId, Currency.wrap(address(0)))
                    + vault.pendingLiquidity(poolId, Currency.wrap(address(0)))
                    + router.protocolClaimable(poolId, Currency.wrap(address(0))) == 10_000,
            "UNEQUAL_SPLIT_NOT_CONSERVED"
        );
    }

    function testSplitRejectsNon100PercentAndSecondConfiguration() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(125)));
        vm.expectRevert();
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 999);
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
        vm.expectRevert();
        router.configure(poolId, address(1), address(2), address(3), 4_000, 3_000, 2_000, 1_000);
    }

    function testConfigurationRejectsZeroDestinationAndUnauthorizedCaller() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
            router.claimable(PoolId.wrap(bytes32(uint256(1))), address(creator), Currency.wrap(address(0))) == 9_000,
            "100_CREATOR"
        );
        require(
            router.claimable(PoolId.wrap(bytes32(uint256(3))), address(treasury), Currency.wrap(address(0))) == 9_000,
            "100_TREASURY"
        );
        require(
            router.claimable(PoolId.wrap(bytes32(uint256(4))), address(community), Currency.wrap(address(0))) == 9_000,
            "100_COMMUNITY"
        );
        require(
            vault.pendingLiquidity(PoolId.wrap(bytes32(uint256(2))), Currency.wrap(address(0))) == 9_000,
            "100_LIQUIDITY"
        );
    }

    function testProtocolShareIsIndependentOfProjectTreasuryAndSmallFeeRounding() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        Currency nativeCurrency = Currency.wrap(address(0));
        PoolId zeroTreasuryPool = PoolId.wrap(bytes32(uint256(20_001)));
        router.configure(zeroTreasuryPool, address(creator), address(0), address(community), 10_000, 0, 0, 0);
        vm.deal(address(this), 101);
        router.route{value: 1}(zeroTreasuryPool, nativeCurrency, 1);
        require(router.protocolClaimable(zeroTreasuryPool, nativeCurrency) == 0, "SUB_10_UNIT_PROTOCOL_ROUNDS_DOWN");
        require(router.claimable(zeroTreasuryPool, address(creator), nativeCurrency) == 1, "SMALL_FEE_TO_PROJECT");
        router.route{value: 100}(zeroTreasuryPool, nativeCurrency, 100);
        require(
            router.protocolClaimable(zeroTreasuryPool, nativeCurrency) == 10,
            "PROTOCOL_FIXED_WITH_ZERO_PROJECT_TREASURY"
        );
        require(router.claimable(zeroTreasuryPool, address(creator), nativeCurrency) == 91, "PROJECT_SHARE_NOT_90");
    }

    function testUnauthorizedProtocolClaimAndRevertingProtocolTreasuryPreserveLedger() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        RevertingReceiver globalTreasury = new RevertingReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(globalTreasury)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(20_002)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(0), address(community), 10_000, 0, 0, 0);
        vm.deal(address(this), 1_000);
        router.route{value: 1_000}(poolId, currency, 1_000);
        vm.expectRevert();
        router.claimProtocolFees(poolId, currency);
        require(router.protocolClaimable(poolId, currency) == 100, "UNAUTHORIZED_CLAIM_CHANGED_LEDGER");
        (bool success,) =
            address(globalTreasury).call(abi.encodeCall(globalTreasury.claimProtocol, (router, poolId, currency)));
        require(!success, "REVERTING_GLOBAL_TREASURY_PAID");
        require(router.protocolClaimable(poolId, currency) == 100, "FAILED_PROTOCOL_CLAIM_LOST_FUNDS");
        require(router.claimable(poolId, address(creator), currency) == 900, "TREASURY_REJECTION_BLOCKED_PROJECT");
        vm.expectRevert();
        router.claimProtocolLaunchFees();
    }

    function testLaunchFeeIsAccruedSeparatelyAndOnlySuccessfulLaunchKeepsIt() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory,, SplitFeeRouter router,) =
            deployer.deploy(IPoolManager(address(manager)), address(treasury));
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "Launch Fee",
            symbol: "FEE",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 10_000,
            liquidityBps: 0,
            projectTreasuryBps: 0,
            communityBps: 0,
            projectTreasury: address(0),
            community: address(0xCAFE),
            salt: keccak256("v11-launch-fee")
        });
        vm.deal(address(this), 2 ether);
        vm.expectRevert();
        factory.launch{value: 1 ether}(params);
        require(router.protocolLaunchFeesAccrued() == 0, "FAILED_LAUNCH_LEFT_FEE");
        (address token, PoolId poolId) = factory.launch{value: 1.0005 ether}(params);
        require(factory.launchedToken(token), "LAUNCH_FAILED");
        require(router.protocolLaunchFeesAccrued() == 0.0005 ether, "FIXED_LAUNCH_FEE_NOT_ACCRUED");
        require(
            router.liquidityVault().pendingLiquidity(poolId, Currency.wrap(address(0))) == 0, "LAUNCH_FEE_WENT_TO_VAULT"
        );
        vm.expectRevert();
        router.claimProtocolLaunchFees();
        treasury.claimProtocolLaunchFees(router);
        require(address(treasury).balance == 0.0005 ether, "LAUNCH_FEE_NOT_CLAIMED_TO_GLOBAL_TREASURY");
    }

    function testRevertingRecipientDoesNotBlockOtherAllocationsOrFutureProcessing() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        RevertingReceiver community = new RevertingReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(999)));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        vm.deal(address(this), 20_000);
        Currency currency = Currency.wrap(address(0));
        router.route{value: 10_000}(poolId, currency, 10_000);
        require(router.claimable(poolId, address(creator), currency) == 3_600, "CREATOR_BLOCKED");
        require(router.claimable(poolId, address(treasury), currency) == 1_800, "PROJECT_TREASURY_BLOCKED");
        require(router.claimable(poolId, address(community), currency) == 900, "COMMUNITY_NOT_CLAIMABLE");
        require(router.protocolClaimable(poolId, currency) == 1_000, "PROTOCOL_NOT_CLAIMABLE");
        require(vault.pendingLiquidity(poolId, currency) == 2_700, "LIQUIDITY_BLOCKED");
        router.route{value: 10_000}(poolId, currency, 10_000);
        require(router.claimable(poolId, address(creator), currency) == 7_200, "FUTURE_PROCESS_BLOCKED");
        require(router.claimable(poolId, address(community), currency) == 1_800, "FUTURE_COMMUNITY_BLOCKED");
        require(router.protocolClaimable(poolId, currency) == 2_000, "FUTURE_PROTOCOL_BLOCKED");
        require(vault.pendingLiquidity(poolId, currency) == 5_400, "FUTURE_LIQUIDITY_BLOCKED");
    }

    function testRevertingProjectTreasuryCannotBlockOtherClaimsOrPools() external {
        NativeReceiver protocolTreasury = new NativeReceiver();
        NativeReceiver creator = new NativeReceiver();
        RevertingReceiver projectTreasury = new RevertingReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(protocolTreasury)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_008)));
        Currency currency = Currency.wrap(address(0));
        router.configure(
            poolId, address(creator), address(projectTreasury), address(community), 4_000, 3_000, 2_000, 1_000
        );
        vm.deal(address(this), 20_000);
        router.route{value: 10_000}(poolId, currency, 10_000);

        (bool projectClaimSucceeded,) =
            address(projectTreasury).call(abi.encodeCall(projectTreasury.claim, (router, poolId, currency)));
        require(!projectClaimSucceeded, "REJECTING_PROJECT_TREASURY_CLAIM_SUCCEEDED");
        require(router.claimable(poolId, address(projectTreasury), currency) == 1_800, "PROJECT_BALANCE_NOT_RETRYABLE");

        creator.claim(router, poolId, currency);
        community.claim(router, poolId, currency);
        protocolTreasury.claimProtocol(router, poolId, currency);
        require(address(creator).balance == 3_600, "CREATOR_CLAIM_BLOCKED");
        require(address(community).balance == 900, "COMMUNITY_CLAIM_BLOCKED");
        require(address(protocolTreasury).balance == 1_000, "PROTOCOL_CLAIM_BLOCKED");
        require(vault.pendingLiquidity(poolId, currency) == 2_700, "VAULT_CREDIT_BLOCKED");

        PoolId otherPool = PoolId.wrap(bytes32(uint256(1_009)));
        router.configure(otherPool, address(creator), address(projectTreasury), address(community), 10_000, 0, 0, 0);
        router.route{value: 1_000}(otherPool, currency, 1_000);
        require(router.protocolClaimable(otherPool, currency) == 100, "OTHER_POOL_PROTOCOL_BLOCKED");
        require(router.claimable(otherPool, address(creator), currency) == 900, "OTHER_POOL_CREATOR_BLOCKED");
    }

    function testCommunityRejectedClaimPreservesBalanceWhileCreatorAndTreasuryClaim() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        RevertingReceiver community = new RevertingReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_001)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.route{value: 10_000}(poolId, currency, 10_000);

        (bool communityClaimSucceeded,) =
            address(community).call(abi.encodeCall(community.claim, (router, poolId, currency)));
        require(!communityClaimSucceeded, "REJECTING_COMMUNITY_CLAIM_SUCCEEDED");
        require(router.claimable(poolId, address(community), currency) == 900, "FAILED_CLAIM_LOST_BALANCE");

        vm.prank(address(creator));
        router.claim(poolId, currency);
        vm.prank(address(treasury));
        router.claim(poolId, currency);
        vm.prank(address(this));
        router.claimProtocolFees(poolId, currency);
        require(address(creator).balance == 3_600, "CREATOR_CLAIM_FAILED");
        require(address(this).balance >= 1_000, "PROTOCOL_CLAIM_FAILED");
        require(address(treasury).balance == 1_800, "PROJECT_TREASURY_CLAIM_FAILED");
        require(router.claimable(poolId, address(creator), currency) == 0, "CREATOR_NOT_CLEARED");
        require(router.claimable(poolId, address(treasury), currency) == 0, "TREASURY_NOT_CLEARED");
        require(router.claimable(poolId, address(community), currency) == 900, "COMMUNITY_NOT_RETRYABLE");
        require(router.totalRecipientClaimed(poolId, currency) == 5_400, "CLAIM_TOTAL_WRONG");
    }

    function testRecipientCannotClaimTwiceOrAnotherRecipientsAllocation() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_002)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        router.route{value: 10_000}(poolId, currency, 10_000);

        vm.prank(address(0xBAD));
        (bool thiefSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!thiefSucceeded, "THIEF_CLAIMED_FUNDS");
        vm.prank(address(creator));
        router.claim(poolId, currency);
        require(address(creator).balance == 3_600, "FIRST_CLAIM_FAILED");
        vm.prank(address(creator));
        (bool secondSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!secondSucceeded, "DOUBLE_CLAIM_SUCCEEDED");
        require(router.claimable(poolId, address(treasury), currency) == 1_800, "OTHER_BALANCE_CHANGED");
    }

    function testReentrantClaimCannotStealOrClaimTwice() external {
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
        require(router.claimable(poolId, address(treasury), currency) == 1_800, "OTHER_FUNDS_STOLEN");
        require(router.totalRecipientClaimed(poolId, currency) == 3_600, "CLAIMED_TOTAL_WRONG");
    }

    function testClaimsAreIsolatedByPoolAndCurrency() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
        require(router.claimable(firstPool, address(creator), nativeCurrency) == 360, "POOL_ONE_NATIVE");
        require(router.claimable(secondPool, address(creator), nativeCurrency) == 720, "POOL_TWO_NATIVE");
        require(router.claimable(tokenPool, address(creator), tokenCurrency) == 2_700, "TOKEN_CURRENCY");
        require(router.claimable(firstPool, address(creator), tokenCurrency) == 0, "CROSS_POOL_TOKEN_LEAK");
    }

    function testRepeatedProcessClaimCyclesConserveAllValue() external {
        NativeReceiver creator = new NativeReceiver();
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        MockLiquidityVault vault = new MockLiquidityVault();
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
        PoolId poolId = PoolId.wrap(bytes32(uint256(1_007)));
        Currency currency = Currency.wrap(address(0));
        router.configure(poolId, address(creator), address(treasury), address(community), 4_000, 3_000, 2_000, 1_000);
        uint256 total;
        uint256 protocolTotal;
        vm.deal(address(this), 100_000);
        for (uint256 i = 1; i <= 10; ++i) {
            uint256 gross = i * 100;
            router.route{value: gross}(poolId, currency, gross);
            total += gross;
            protocolTotal += gross / 10;
            creator.claim(router, poolId, currency);
            treasury.claim(router, poolId, currency);
            community.claim(router, poolId, currency);
            router.claimProtocolFees(poolId, currency);
            require(router.claimable(poolId, address(creator), currency) == 0, "CREATOR_CLAIMABLE_REMAINS");
            require(router.claimable(poolId, address(treasury), currency) == 0, "TREASURY_CLAIMABLE_REMAINS");
            require(router.claimable(poolId, address(community), currency) == 0, "COMMUNITY_CLAIMABLE_REMAINS");
        }
        uint256 distributed = address(creator).balance + address(treasury).balance + address(community).balance
            + vault.pendingLiquidity(poolId, currency) + protocolTotal;
        require(distributed == total, "REPEATED_CYCLES_NOT_CONSERVED");
        require(router.totalProtocolClaimed(poolId, currency) == protocolTotal, "PROTOCOL_DOUBLE_OR_MISSING_CLAIM");
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
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(treasury),
            community: address(community),
            salt: keccak256("adversarial-recipient")
        });
        bytes memory launchResult =
            creator.execute{value: 1.0005 ether}(address(factory), abi.encodeCall(factory.launch, (launchParams)));
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
            router.claimable(poolId, address(creator), key.currency0)
                == (accruedBefore - accruedBefore / 10) * 4_000 / 10_000,
            "CREATOR_ALLOCATION_MISMATCH"
        );
        require(creator.received() == 0, "PROCESSING_PAID_CREATOR_DIRECTLY");
        require(creator.fallbackWork() == 0, "PROCESSING_RAN_RECIPIENT_CALLBACK");
        require(!creator.hookReentrySucceeded() && !creator.nestedRouteSucceeded(), "RECIPIENT_CALLBACK_RAN");
        require(!creator.privilegedCallSucceeded(), "RECIPIENT_CHANGED_CONFIGURATION");
        require(hook.accrued(poolId, key.currency0) == 0, "ACCRUAL_NOT_ROUTED");
        uint256 projectAmount = accruedBefore - accruedBefore / 10;
        uint256 expectedVaultAmount =
            projectAmount - projectAmount * 4_000 / 10_000 - projectAmount * 2_000 / 10_000 - projectAmount / 10;
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
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(treasury),
            community: address(community),
            salt: keccak256("permanently-reverting-recipient")
        });
        bytes memory launchResult =
            creator.execute{value: 1.0005 ether}(address(factory), abi.encodeCall(factory.launch, (launchParams)));
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
            router.claimable(poolId, address(creator), key.currency0)
                == (accruedBefore - accruedBefore / 10) * 4_000 / 10_000,
            "CREATOR_NOT_ALLOCATED"
        );
        require(
            router.claimable(poolId, address(community), key.currency0) == (accruedBefore - accruedBefore / 10) / 10,
            "COMMUNITY_NOT_ALLOCATED"
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
        SplitFeeRouter router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
        uint256 routed = router.totalRecipientAllocated(poolId, currency) + vault.pendingLiquidity(poolId, currency)
            + router.totalProtocolAllocated(poolId, currency);
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
        require(uint160(address(hook)) & 0x3fff == 0x2044, "WRONG_PERMISSION_BITS");
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
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(treasury),
            community: address(community),
            salt: keccak256("end-to-end")
        });
        (address tokenAddress, PoolId poolId) = factory.launch{value: 1.0005 ether}(params);
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
        params.projectTreasuryBps = 0;
        params.communityBps = 10_000;
        (address tokenAddressB, PoolId poolIdB) = factory.launch{value: 1.0005 ether}(params);
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
        uint256 projectFee = fee - fee / 10;
        uint256 creatorShare = projectFee * 4_000 / 10_000;
        uint256 treasuryShare = projectFee * 2_000 / 10_000;
        uint256 communityShare = projectFee * 1_000 / 10_000;
        uint256 liquidityShare = projectFee - creatorShare - treasuryShare - communityShare;
        require(router.claimable(poolId, address(this), key.currency1) == creatorShare, "CREATOR_SPLIT");
        require(router.claimable(poolId, address(treasury), key.currency1) == treasuryShare, "TREASURY_SPLIT");
        require(router.claimable(poolId, address(community), key.currency1) == communityShare, "COMMUNITY_SPLIT");
        require(vault.pendingLiquidity(poolId, key.currency1) == liquidityShare, "LIQUIDITY_SPLIT");
        require(router.protocolClaimable(poolId, key.currency1) == fee / 10, "PROTOCOL_SPLIT");
        (address configuredCreator,,,,,,,) = router.splits(poolId);
        require(configuredCreator == address(this), "CONFIG_NOT_CREATOR");
        hook.flush(poolIdB, keyB.currency1);
        require(
            router.claimable(poolIdB, address(communityB), keyB.currency1) == (feeB - feeB / 10),
            "PROJECT_B_DID_NOT_RECEIVE_ITS_FEE"
        );
        require(
            token.balanceOf(address(communityB)) == 0 && tokenB.balanceOf(address(community)) == 0,
            "CROSS_PROJECT_FEE_LEAK"
        );
        require(vault.pendingLiquidity(poolIdB, keyB.currency1) == 0, "PROJECT_B_LIQUIDITY_CROSSED");
    }

    function testOfficialSwapExecutorBuysAndSellsWithHookFees() external {
        PoolManager manager = new PoolManager(address(this));
        NativeReceiver treasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        SplitStackDeployer deployer = new SplitStackDeployer();
        (SplitFactory factory, SplitHook hook,,) = deployer.deploy(IPoolManager(address(manager)), address(treasury));
        SplitSwapExecutor executor = new SplitSwapExecutor(factory);
        vm.deal(address(this), 3 ether);
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "Executor Test",
            symbol: "EXEC",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(treasury),
            community: address(community),
            salt: keccak256("executor")
        });
        (address tokenAddress, PoolId poolId) = factory.launch{value: 1.0005 ether}(params);
        SplitToken token = SplitToken(tokenAddress);
        (PoolKey memory key, PoolId resolvedId) = executor.officialPool(tokenAddress);
        require(PoolId.unwrap(resolvedId) == PoolId.unwrap(poolId), "WRONG_OFFICIAL_POOL");
        require(
            Currency.unwrap(key.currency0) == address(0) && Currency.unwrap(key.currency1) == tokenAddress,
            "WRONG_ORDER"
        );

        uint256 tokenBeforeBuy = token.balanceOf(address(this));
        uint256 bought = executor.buy{value: 1e15}(tokenAddress, 1, block.timestamp + 600);
        require(bought > 0 && token.balanceOf(address(this)) == tokenBeforeBuy + bought, "BUY_OUTPUT");
        require(hook.accrued(poolId, Currency.wrap(tokenAddress)) > 0, "BUY_HOOK_FEE_MISSING");

        uint256 sellAmount = bought / 2;
        token.approve(address(executor), sellAmount);
        uint256 ethBeforeSell = address(this).balance;
        uint256 sold = executor.sell(tokenAddress, sellAmount, 1, block.timestamp + 600);
        require(sold > 0 && address(this).balance == ethBeforeSell + sold, "SELL_OUTPUT");
        require(hook.accrued(poolId, Currency.wrap(address(0))) > 0, "SELL_HOOK_FEE_MISSING");
        require(token.allowance(address(this), address(executor)) == 0, "APPROVAL_NOT_EXACTLY_CONSUMED");

        vm.expectRevert();
        executor.sell(tokenAddress, sellAmount, 1, block.timestamp + 600);
        token.approve(address(executor), sellAmount);
        vm.expectRevert();
        executor.sell(tokenAddress, sellAmount, type(uint256).max, block.timestamp + 600);
        require(token.allowance(address(this), address(executor)) == sellAmount, "FAILED_SELL_CONSUMED_APPROVAL");

        vm.expectRevert();
        executor.buy{value: 0}(tokenAddress, 1, block.timestamp + 600);
        vm.expectRevert();
        executor.buy{value: 1e15}(address(0xBEEF), 1, block.timestamp + 600);
        vm.expectRevert();
        executor.buy{value: 1e15}(tokenAddress, type(uint256).max, block.timestamp + 600);
        vm.expectRevert();
        executor.buy{value: 1e15}(tokenAddress, 1, 0);
        vm.expectRevert();
        executor.unlockCallback("");
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
        require(forkBlock == 73_152_779, "UNEXPECTED_FORK_BLOCK");
        vm.rollFork(forkBlock + 1);
        require(
            blockhash(forkBlock) == 0x7f624ae3099fd979b0479291cb80adf8a4daab2ea3be07a2e23a038b9aedea06,
            "UNEXPECTED_FORK_BLOCK_HASH"
        );
        vm.rollFork(forkBlock);
        require(block.chainid == 4663, "NOT_RH_MAINNET_FORK");

        IPoolManager manager = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        require(address(manager).code.length != 0, "OFFICIAL_POOL_MANAGER_MISSING");
        require(
            keccak256(address(manager).code) == 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626,
            "POOL_MANAGER_CODE_HASH_MISMATCH"
        );
        bytes32 managerStorageWord = vm.load(address(manager), bytes32(0));
        require(managerStorageWord == vm.load(address(manager), bytes32(0)), "POOL_MANAGER_HISTORICAL_STORAGE_FAILED");
        (bool poolManagerCallSucceeded,) =
            address(manager).staticcall(abi.encodeWithSignature("extsload(bytes32)", bytes32(0)));
        require(poolManagerCallSucceeded, "POOL_MANAGER_HISTORICAL_CALL_FAILED");
        NativeReceiver protocolTreasury = new NativeReceiver();
        NativeReceiver projectTreasury = new NativeReceiver();
        NativeReceiver community = new NativeReceiver();
        // Match DeploySplit's deterministic simulated sender and nonce for reproducible
        // helper and child CREATE/CREATE2 address checks in the fork lifecycle.
        address simulatedDeployer = 0x000000000000000000000000000000000000dEaD;
        uint256 helperCreateStart = gasleft();
        vm.prank(simulatedDeployer);
        ProductionSplitStackDeployer deployer = new ProductionSplitStackDeployer(manager, address(protocolTreasury));
        uint256 helperCreateGas = helperCreateStart - gasleft();
        require(address(deployer) == 0x9B137463d4E7986D7f535f9B79e28b4EF1938E9b, "SCRIPT_DEPLOYER_ADDRESS_MISMATCH");
        bytes32 hookSalt = _findProductionHookSalt(manager, address(deployer));
        uint256 stackCreationStart = gasleft();
        vm.prank(simulatedDeployer);
        (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault) =
            deployer.deploy(hookSalt);
        emit ForkStackDeploymentGas(address(deployer), helperCreateGas, stackCreationStart - gasleft());
        require(factory.protocolTreasury() == address(protocolTreasury), "FACTORY_PROTOCOL_TREASURY_MISMATCH");
        require(router.protocolTreasury() == address(protocolTreasury), "ROUTER_PROTOCOL_TREASURY_MISMATCH");
        forkRouter = router;
        forkVault = vault;

        vm.deal(address(this), 10 ether);
        SplitFactory.LaunchParams memory params = SplitFactory.LaunchParams({
            name: "SPLIT RH Fork Test",
            symbol: "RHFORK",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(projectTreasury),
            community: address(community),
            salt: keccak256("rh-mainnet-pinned-fork")
        });
        uint256 creatorEthBeforeLaunch = address(this).balance;
        uint256 managerEthBeforeLaunch = address(manager).balance;
        (address tokenAddress, PoolId poolId) = factory.launch{value: 1.0007 ether}(params);
        uint256 seededQuote = address(manager).balance - managerEthBeforeLaunch;
        require(
            creatorEthBeforeLaunch - address(this).balance == factory.LAUNCH_FEE() + seededQuote,
            "EXCESS_REFUND_MISMATCH"
        );
        require(router.protocolLaunchFeesAccrued() == factory.LAUNCH_FEE(), "LAUNCH_FEE_NOT_ACCRUED");
        require(address(router).balance == factory.LAUNCH_FEE(), "LAUNCH_FEE_NOT_SEPARATE_FROM_SEED");
        require(address(factory).balance == 0, "FACTORY_RETAINED_LAUNCH_VALUE");
        require(seededQuote <= params.seedQuoteAmount && seededQuote > 0, "SEED_QUOTE_NOT_VAULTED");
        require(hook.registeredPool(poolId), "POOL_NOT_REGISTERED");
        require(vault.positionLiquidity(poolId) != 0, "FORK_SEED_POSITION_MISSING");
        SplitToken launchedToken = SplitToken(tokenAddress);
        require(launchedToken.totalSupply() == factory.TOTAL_SUPPLY(), "FORK_SUPPLY_MISMATCH");
        require(launchedToken.balanceOf(address(manager)) != 0, "SEEDED_TOKEN_NOT_IN_POOL_MANAGER");
        require(
            launchedToken.balanceOf(address(this)) == factory.TOTAL_SUPPLY() - params.tokenSeedAmount,
            "CREATOR_SUPPLY_MISMATCH"
        );
        (bool mintSucceeded,) = tokenAddress.call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        require(!mintSucceeded, "POST_LAUNCH_MINT_AVAILABLE");
        require(
            address(this) != address(protocolTreasury) && address(this) != address(community), "RECIPIENTS_NOT_DISTINCT"
        );
        require(address(projectTreasury) != address(protocolTreasury), "PROTOCOL_AND_PROJECT_TREASURY_NOT_DISTINCT");
        require(address(projectTreasury) != address(community), "RECIPIENTS_NOT_DISTINCT");
        (
            address configuredCreator,
            address configuredProjectTreasury,
            address configuredCommunity,
            uint16 creatorBps,
            uint16 liquidityBps,
            uint16 projectTreasuryBps,
            uint16 communityBps,
            bool configured
        ) = router.splits(poolId);
        require(
            configured && configuredCreator == address(this) && configuredProjectTreasury == address(projectTreasury)
                && configuredCommunity == address(community) && creatorBps == 4_000 && liquidityBps == 3_000
                && projectTreasuryBps == 2_000 && communityBps == 1_000,
            "FORK_SPLIT_CONFIGURATION_MISMATCH"
        );
        vm.prank(address(factory));
        (bool reconfigureSucceeded,) = address(router)
            .call(
                abi.encodeCall(
                    router.configure,
                    (
                        poolId,
                        address(this),
                        address(projectTreasury),
                        address(community),
                        uint16(3_000),
                        uint16(4_000),
                        uint16(2_000),
                        uint16(1_000)
                    )
                )
            );
        require(!reconfigureSucceeded, "FORK_SPLIT_RECONFIGURED");

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

        _verifyForkPositionCustody(manager, vault, deployer, key, poolId, params.salt);
        require(vault.pendingLiquidity(poolId, key.currency0) != 0, "NATIVE_LIQUIDITY_NOT_CREDITED");
        require(vault.pendingLiquidity(poolId, key.currency1) != 0, "TOKEN_LIQUIDITY_NOT_CREDITED");
        _claimForkAllocations(router, protocolTreasury, projectTreasury, community, tokenAddress, poolId);

        ISplitV4Quoter quoter = ISplitV4Quoter(0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94);
        require(address(quoter).code.length != 0, "OFFICIAL_V4_QUOTER_MISSING");
        (uint256 quotedBuy,) = quoter.quoteExactInputSingle(
            ISplitV4Quoter.QuoteExactSingleParams({poolKey: key, zeroForOne: true, exactAmount: 1e15, hookData: ""})
        );
        SplitSwapExecutor swapExecutor = new SplitSwapExecutor(factory);
        uint256 actualBuy = swapExecutor.buy{value: 1e15}(tokenAddress, quotedBuy * 99 / 100, block.timestamp + 600);
        require(actualBuy == quotedBuy, "FORK_QUOTE_DID_NOT_INCLUDE_HOOK_FEE");

        // A successful launch fee is rolled back if a later refund fails, even
        // though the fee was first credited to the router's pull-claim ledger.
        AdversarialReceiver rejectingCreator = new AdversarialReceiver(address(this));
        rejectingCreator.permanentlyRejectNative();
        SplitFactory.LaunchParams memory failedParams = params;
        failedParams.name = "SPLIT RH Failed Refund";
        failedParams.symbol = "RHFAIL";
        failedParams.salt = keccak256("rh-mainnet-failed-refund");
        uint256 feeLedgerBeforeFailure = router.protocolLaunchFeesAccrued();
        uint256 vaultBalanceBeforeFailure = address(vault).balance;
        (bool insufficientLaunch,) =
            address(factory).call{value: 1.0004 ether}(abi.encodeCall(factory.launch, (failedParams)));
        require(!insufficientLaunch, "INSUFFICIENT_LAUNCH_PAYMENT_SUCCEEDED");
        require(router.protocolLaunchFeesAccrued() == feeLedgerBeforeFailure, "INSUFFICIENT_LAUNCH_CHARGED_FEE");
        (bool failedLaunch,) = address(rejectingCreator).call{value: 1.0007 ether}(
            abi.encodeCall(rejectingCreator.execute, (address(factory), abi.encodeCall(factory.launch, (failedParams))))
        );
        require(!failedLaunch, "REJECTED_REFUND_LAUNCH_SUCCEEDED");
        require(router.protocolLaunchFeesAccrued() == feeLedgerBeforeFailure, "FAILED_LAUNCH_RETAINED_FEE");
        require(address(vault).balance == vaultBalanceBeforeFailure, "FAILED_LAUNCH_RETAINED_SEED");

        // A zero-percent Project Treasury is valid; the global protocol share
        // remains fixed while all of the programmable portion goes to Creator.
        SplitFactory.LaunchParams memory zeroProjectTreasuryParams = SplitFactory.LaunchParams({
            name: "SPLIT RH Zero Project Treasury",
            symbol: "RHZERO",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 10_000,
            liquidityBps: 0,
            projectTreasuryBps: 0,
            communityBps: 0,
            projectTreasury: address(0),
            community: address(community),
            salt: keccak256("rh-mainnet-zero-project-treasury")
        });
        (address zeroTreasuryToken, PoolId zeroTreasuryPool) =
            factory.launch{value: 1.0005 ether}(zeroProjectTreasuryParams);
        PoolKey memory zeroTreasuryKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(zeroTreasuryToken),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        _runObservedForkSwap(
            manager, hook, zeroTreasuryKey, zeroTreasuryPool, true, -int256(1e15), zeroTreasuryKey.currency1
        );
        uint256 zeroProjectProtocolAmount = router.protocolClaimable(zeroTreasuryPool, zeroTreasuryKey.currency1);
        uint256 zeroProjectCreatorAmount = router.claimable(zeroTreasuryPool, address(this), zeroTreasuryKey.currency1);
        require(zeroProjectProtocolAmount != 0, "ZERO_PROJECT_TREASURY_REMOVED_PROTOCOL_SHARE");
        require(zeroProjectCreatorAmount != 0, "ZERO_PROJECT_TREASURY_CREATOR_SHARE_MISSING");
        require(
            router.claimable(zeroTreasuryPool, address(projectTreasury), zeroTreasuryKey.currency1) == 0,
            "ZERO_PROJECT_TREASURY_NOT_ZERO"
        );
        require(
            vault.pendingLiquidity(zeroTreasuryPool, zeroTreasuryKey.currency1) == 0, "ZERO_LIQUIDITY_SHARE_NOT_ZERO"
        );
        uint256 protocolTokenBefore = SplitToken(zeroTreasuryToken).balanceOf(address(protocolTreasury));
        protocolTreasury.claimProtocol(router, zeroTreasuryPool, zeroTreasuryKey.currency1);
        require(
            SplitToken(zeroTreasuryToken).balanceOf(address(protocolTreasury)) - protocolTokenBefore
                == zeroProjectProtocolAmount,
            "ZERO_PROJECT_PROTOCOL_CLAIM_DELTA"
        );
        router.claim(zeroTreasuryPool, zeroTreasuryKey.currency1);
        require(
            router.claimable(zeroTreasuryPool, address(this), zeroTreasuryKey.currency1) == 0,
            "ZERO_PROJECT_CREATOR_CLAIM_FAILED"
        );

        // A rejecting per-project treasury cannot block the protocol, creator,
        // community, liquidity credit, or another pool.
        RevertingReceiver rejectingProjectTreasury = new RevertingReceiver();
        SplitFactory.LaunchParams memory rejectParams = SplitFactory.LaunchParams({
            name: "SPLIT RH Reject Project Treasury",
            symbol: "RHTREJ",
            tokenSeedAmount: 1 ether,
            seedQuoteAmount: 1 ether,
            creatorBps: 4_000,
            liquidityBps: 3_000,
            projectTreasuryBps: 2_000,
            communityBps: 1_000,
            projectTreasury: address(rejectingProjectTreasury),
            community: address(community),
            salt: keccak256("rh-mainnet-reverting-recipient")
        });
        (address rejectTokenAddress, PoolId rejectPoolId) = factory.launch{value: 1.0005 ether}(rejectParams);
        PoolKey memory rejectKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(rejectTokenAddress),
            fee: factory.LP_FEE(),
            tickSpacing: factory.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        _runObservedForkSwap(manager, hook, rejectKey, rejectPoolId, true, int256(1e15), rejectKey.currency0);
        uint256 rejectedAmount = router.claimable(rejectPoolId, address(rejectingProjectTreasury), rejectKey.currency0);
        require(rejectedAmount != 0, "REJECT_RECIPIENT_NOT_CLAIMABLE");
        uint256 rejectedGasBefore = gasleft();
        (bool rejectSucceeded,) = address(rejectingProjectTreasury)
            .call(abi.encodeCall(rejectingProjectTreasury.claim, (router, rejectPoolId, rejectKey.currency0)));
        uint256 rejectedGasUsed = rejectedGasBefore - gasleft();
        emit ForkRejectedClaimGas(
            address(rejectingProjectTreasury), Currency.unwrap(rejectKey.currency0), rejectedAmount, rejectedGasUsed
        );
        require(!rejectSucceeded, "REJECTING_PROJECT_TREASURY_CLAIM_SUCCEEDED");
        require(
            router.claimable(rejectPoolId, address(rejectingProjectTreasury), rejectKey.currency0) == rejectedAmount,
            "REJECTED_CLAIM_BALANCE_LOST"
        );
        uint256 creatorClaim = router.claimable(rejectPoolId, address(this), rejectKey.currency0);
        uint256 communityClaim = router.claimable(rejectPoolId, address(community), rejectKey.currency0);
        uint256 protocolClaim = router.protocolClaimable(rejectPoolId, rejectKey.currency0);
        require(creatorClaim != 0 && communityClaim != 0 && protocolClaim != 0, "OTHER_REJECT_POOL_CLAIMS_MISSING");
        router.claim(rejectPoolId, rejectKey.currency0);
        community.claim(router, rejectPoolId, rejectKey.currency0);
        protocolTreasury.claimProtocol(router, rejectPoolId, rejectKey.currency0);
        require(router.claimable(rejectPoolId, address(this), rejectKey.currency0) == 0, "REJECT_BLOCKED_CREATOR");
        require(
            router.claimable(rejectPoolId, address(community), rejectKey.currency0) == 0, "REJECT_BLOCKED_COMMUNITY"
        );
        require(router.protocolClaimable(rejectPoolId, rejectKey.currency0) == 0, "REJECT_BLOCKED_PROTOCOL");

        uint256 launchFeesBeforeClaim = router.protocolLaunchFeesAccrued();
        require(launchFeesBeforeClaim == factory.LAUNCH_FEE() * 3, "SUCCESSFUL_LAUNCH_FEE_TOTAL_WRONG");
        uint256 protocolEthBeforeLaunchClaim = address(protocolTreasury).balance;
        protocolTreasury.claimProtocolLaunchFees(router);
        require(
            address(protocolTreasury).balance - protocolEthBeforeLaunchClaim == launchFeesBeforeClaim,
            "LAUNCH_FEE_CLAIM_DELTA"
        );
        require(router.protocolLaunchFeesAccrued() == 0, "LAUNCH_FEE_LEDGER_NOT_CLEARED");
    }

    function _findProductionHookSalt(IPoolManager manager, address deployer) private pure returns (bytes32 salt) {
        address routerAddress = _predictedCreateAddress(deployer, 2);
        address factoryAddress = _predictedCreateAddress(deployer, 4);
        bytes memory hookCode = abi.encodePacked(
            type(SplitHook).creationCode, abi.encode(manager, factoryAddress, SplitFeeRouter(payable(routerAddress)))
        );
        bytes32 initCodeHash = keccak256(hookCode);
        for (uint256 nonce; nonce < type(uint256).max; ++nonce) {
            salt = bytes32(nonce);
            address predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(predicted) & 0x3fff == 0x2044) return salt;
        }
        revert("HOOK_SALT_NOT_FOUND");
    }

    function _predictedCreateAddress(address deployer, uint8 nonce) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", deployer, bytes1(nonce))))));
    }

    function _verifyForkPositionCustody(
        IPoolManager manager,
        SplitLiquidityVault vault,
        ProductionSplitStackDeployer deployer,
        PoolKey memory key,
        PoolId poolId,
        bytes32 salt
    ) private {
        uint128 vaultLiquidity = vault.positionLiquidity(poolId);
        bytes32 positionKey = Position.calculatePositionKey(address(vault), -887220, 887220, salt);
        require(vaultLiquidity != 0, "VAULT_POSITION_MISSING");
        require(
            StateLibrary.getPositionLiquidity(manager, poolId, positionKey) == vaultLiquidity,
            "POOL_MANAGER_POSITION_OWNER_MISMATCH"
        );
        activeManager = manager;
        activeRemovalAttempt = true;
        (bool creatorRemoved,) = address(manager)
            .call(
                abi.encodeWithSelector(manager.unlock.selector, abi.encode(key, -887220, 887220, salt, vaultLiquidity))
            );
        activeRemovalAttempt = false;
        require(!creatorRemoved, "CREATOR_REMOVED_VAULT_POSITION");
        PositionStealer arbitraryAttempt = new PositionStealer(manager);
        require(
            !arbitraryAttempt.attemptRemoval(key, -887220, 887220, salt, vaultLiquidity),
            "ARBITRARY_REMOVED_VAULT_POSITION"
        );
        vm.prank(address(deployer));
        (bool deployerRemoved,) = address(manager)
            .call(
                abi.encodeWithSelector(manager.unlock.selector, abi.encode(key, -887220, 887220, salt, vaultLiquidity))
            );
        require(!deployerRemoved, "DEPLOYER_REMOVED_VAULT_POSITION");
        (bool removed,) =
            address(vault).call(abi.encodeWithSignature("removeLiquidity(bytes32,uint256)", PoolId.unwrap(poolId), 1));
        require(!removed, "VAULT_WITHDRAW_PATH_EXISTS");
        bytes4[4] memory unavailableSelectors = [
            bytes4(keccak256("withdraw(bytes32,address,uint256)")),
            bytes4(keccak256("transferPosition(bytes32,address)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("rescueToken(address,address,uint256)"))
        ];
        for (uint256 i; i < unavailableSelectors.length; ++i) {
            vm.prank(address(deployer));
            (bool deployerCallSucceeded,) =
                address(vault).call(abi.encodeWithSelector(unavailableSelectors[i], address(0xBEEF), 1));
            require(!deployerCallSucceeded, "DEPLOYER_VAULT_CUSTODY_PATH");
            (bool arbitraryCallSucceeded,) =
                address(vault).call(abi.encodeWithSelector(unavailableSelectors[i], address(0xBEEF), 1));
            require(!arbitraryCallSucceeded, "ARBITRARY_VAULT_CUSTODY_PATH");
        }
        require(
            StateLibrary.getPositionLiquidity(manager, poolId, positionKey) == vaultLiquidity,
            "POSITION_CHANGED_AFTER_ATTACKS"
        );
    }

    function _claimForkAllocations(
        SplitFeeRouter router,
        NativeReceiver protocolTreasury,
        NativeReceiver projectTreasury,
        NativeReceiver community,
        address tokenAddress,
        PoolId poolId
    ) private {
        Currency[2] memory currencies = [Currency.wrap(address(0)), Currency.wrap(tokenAddress)];
        for (uint256 i; i < currencies.length; ++i) {
            Currency currency = currencies[i];
            uint256 creatorClaimable = router.claimable(poolId, address(this), currency);
            vm.prank(address(0xA11CE));
            (bool unauthorizedSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
            require(!unauthorizedSucceeded, "UNAUTHORIZED_CLAIM_SUCCEEDED");
            require(
                router.claimable(poolId, address(this), currency) == creatorClaimable,
                "UNAUTHORIZED_CLAIM_CHANGED_BALANCE"
            );
            vm.prank(address(0xA11CE));
            (bool unauthorizedProtocolSucceeded,) =
                address(router).call(abi.encodeCall(router.claimProtocolFees, (poolId, currency)));
            require(!unauthorizedProtocolSucceeded, "UNAUTHORIZED_PROTOCOL_CLAIM_SUCCEEDED");
            _measureForkClaim(router, address(projectTreasury), poolId, currency, true, projectTreasury, tokenAddress);
            _measureForkClaim(router, address(community), poolId, currency, true, community, tokenAddress);
            _measureForkClaim(router, address(this), poolId, currency, false, projectTreasury, tokenAddress);
            _measureForkProtocolClaim(router, protocolTreasury, poolId, currency, tokenAddress);
        }
    }

    function _measureForkProtocolClaim(
        SplitFeeRouter router,
        NativeReceiver protocolTreasury,
        PoolId poolId,
        Currency currency,
        address tokenAddress
    ) private {
        uint256 amount = router.protocolClaimable(poolId, currency);
        require(amount != 0, "FORK_PROTOCOL_CLAIMABLE_MISSING");
        uint256 recipientBefore = _currencyBalance(address(protocolTreasury), currency, tokenAddress);
        uint256 gasBefore = gasleft();
        protocolTreasury.claimProtocol(router, poolId, currency);
        uint256 gasUsed = gasBefore - gasleft();
        uint256 recipientAfter = _currencyBalance(address(protocolTreasury), currency, tokenAddress);
        require(recipientAfter - recipientBefore == amount, "FORK_PROTOCOL_CLAIM_DELTA_MISMATCH");
        require(router.protocolClaimable(poolId, currency) == 0, "FORK_PROTOCOL_CLAIMABLE_NOT_CLEARED");
        (bool doubleClaimSucceeded,) =
            address(protocolTreasury).call(abi.encodeCall(protocolTreasury.claimProtocol, (router, poolId, currency)));
        require(!doubleClaimSucceeded, "FORK_PROTOCOL_DOUBLE_CLAIM_SUCCEEDED");
        emit ForkClaimGas(
            address(protocolTreasury),
            Currency.unwrap(currency),
            amount,
            amount,
            recipientBefore,
            gasUsed,
            0,
            recipientAfter
        );
    }

    function _measureForkClaim(
        SplitFeeRouter router,
        address recipient,
        PoolId poolId,
        Currency currency,
        bool viaReceiver,
        NativeReceiver receiver,
        address tokenAddress
    ) private {
        uint256 amount = router.claimable(poolId, recipient, currency);
        require(amount != 0, "FORK_CLAIMABLE_MISSING");
        uint256 recipientBefore = _currencyBalance(recipient, currency, tokenAddress);
        (address creator, address projectTreasury, address community,,,,,) = router.splits(poolId);
        address[3] memory recipients = [creator, projectTreasury, community];
        uint256[3] memory otherClaimsBefore;
        uint256[3] memory currentBalancesBefore;
        uint256[3] memory otherCurrencyBalancesBefore;
        Currency otherCurrency =
            Currency.unwrap(currency) == address(0) ? Currency.wrap(tokenAddress) : Currency.wrap(address(0));
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] != recipient) {
                otherClaimsBefore[i] = router.claimable(poolId, recipients[i], currency);
                currentBalancesBefore[i] = _currencyBalance(recipients[i], currency, tokenAddress);
            }
            otherCurrencyBalancesBefore[i] = _currencyBalance(recipients[i], otherCurrency, tokenAddress);
        }
        uint256 gasBefore = gasleft();
        if (viaReceiver) receiver.claim(router, poolId, currency);
        else router.claim(poolId, currency);
        uint256 gasUsed = gasBefore - gasleft();
        uint256 recipientAfter = _currencyBalance(recipient, currency, tokenAddress);
        uint256 claimableAfter = router.claimable(poolId, recipient, currency);
        require(recipientAfter - recipientBefore == amount, "FORK_CLAIM_DELTA_MISMATCH");
        require(claimableAfter == 0, "FORK_CLAIMABLE_NOT_CLEARED");
        vm.prank(recipient);
        (bool doubleClaimSucceeded,) = address(router).call(abi.encodeCall(router.claim, (poolId, currency)));
        require(!doubleClaimSucceeded, "FORK_DOUBLE_CLAIM_SUCCEEDED");
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] != recipient) {
                require(
                    router.claimable(poolId, recipients[i], currency) == otherClaimsBefore[i],
                    "FORK_OTHER_CLAIMABLE_CHANGED"
                );
                require(
                    _currencyBalance(recipients[i], currency, tokenAddress) == currentBalancesBefore[i],
                    "FORK_OTHER_RECIPIENT_BALANCE_CHANGED"
                );
            }
            require(
                _currencyBalance(recipients[i], otherCurrency, tokenAddress) == otherCurrencyBalancesBefore[i],
                "FORK_UNRELATED_CURRENCY_CHANGED"
            );
        }
        emit ForkClaimGas(
            recipient,
            Currency.unwrap(currency),
            amount,
            amount,
            recipientBefore,
            gasUsed,
            claimableAfter,
            recipientAfter
        );
    }

    function _currencyBalance(address account, Currency currency, address tokenAddress) private view returns (uint256) {
        if (Currency.unwrap(currency) == address(0)) return account.balance;
        return SplitToken(tokenAddress).balanceOf(account);
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
        uint256 protocolBefore = router.totalProtocolAllocated(poolId, currency);
        uint256 liquidityBefore = vault.pendingLiquidity(poolId, currency);
        uint256 creatorBefore = router.claimable(poolId, address(this), currency);
        (
            address creator,
            address projectTreasury,
            address community,
            uint16 creatorBps,
            uint16 liquidityBps,
            uint16 projectTreasuryBps,
            uint16 communityBps,
        ) = router.splits(poolId);
        require(creator == address(this), "FORK_CREATOR_MISMATCH");
        uint256 projectTreasuryBefore = router.claimable(poolId, projectTreasury, currency);
        uint256 communityBefore = router.claimable(poolId, community, currency);
        uint256 protocolClaimBefore = router.protocolClaimable(poolId, currency);
        hook.flush(poolId, currency);
        uint256 routerBalanceAfter = currency == key.currency0
            ? address(router).balance
            : SplitToken(Currency.unwrap(key.currency1)).balanceOf(address(router));
        uint256 recipientAllocation = router.totalRecipientAllocated(poolId, currency) - allocationsBefore;
        uint256 liquidityCredit = vault.pendingLiquidity(poolId, currency) - liquidityBefore;
        require(
            router.claimable(poolId, address(this), currency) - creatorBefore == (fee - fee / 10) * creatorBps / 10_000,
            "FORK_CREATOR_SPLIT"
        );
        require(
            router.claimable(poolId, projectTreasury, currency) - projectTreasuryBefore
                == (fee - fee / 10) * projectTreasuryBps / 10_000,
            "FORK_PROJECT_TREASURY_SPLIT"
        );
        require(
            router.claimable(poolId, community, currency) - communityBefore == (fee - fee / 10) * communityBps / 10_000,
            "FORK_COMMUNITY_SPLIT"
        );
        uint256 protocolAllocation = router.totalProtocolAllocated(poolId, currency) - protocolBefore;
        require(protocolAllocation == fee / 10, "FORK_PROTOCOL_SPLIT");
        require(
            router.protocolClaimable(poolId, currency) - protocolClaimBefore == protocolAllocation,
            "FORK_PROTOCOL_CLAIMABLE"
        );
        uint256 projectAmount = fee - fee / 10;
        require(
            liquidityCredit
                == projectAmount - projectAmount * creatorBps / 10_000 - projectAmount * projectTreasuryBps / 10_000
                    - projectAmount * communityBps / 10_000,
            "FORK_LIQUIDITY_SPLIT"
        );
        require(liquidityCredit >= projectAmount * liquidityBps / 10_000, "FORK_LIQUIDITY_BPS_MISMATCH");
        require(
            routerBalanceAfter - routerBalanceBefore == recipientAllocation + protocolAllocation,
            "FORK_CLAIM_BACKING_MISMATCH"
        );
        require(recipientAllocation + liquidityCredit + protocolAllocation == fee, "FORK_ROUTING_NOT_CONSERVED");
        require(hook.accrued(poolId, currency) == 0, "FORK_ACCRUAL_NOT_SETTLED");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(activeManager), "UNEXPECTED_UNLOCK");
        if (activeRemovalAttempt) {
            (PoolKey memory removalKey, int24 tickLower, int24 tickUpper, bytes32 salt, uint128 liquidity) =
                abi.decode(data, (PoolKey, int24, int24, bytes32, uint128));
            activeManager.modifyLiquidity(
                removalKey, ModifyLiquidityParams(tickLower, tickUpper, -int256(uint256(liquidity)), salt), ""
            );
            return "";
        }
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
        for (uint256 i; i < 262_144; ++i) {
            bytes32 salt = bytes32(i);
            address predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
            if (uint160(predicted) & 0x3fff != 0x2044) continue;
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
        router = new SplitFeeRouter(
            address(this), address(this), SplitLiquidityVault(payable(address(vault))), address(this)
        );
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
        uint256 processed = router.totalRecipientAllocated(poolId, currency)
            + handler.vault().pendingLiquidity(poolId, currency) + router.totalProtocolAllocated(poolId, currency);
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
        require(
            router.totalProtocolAllocated(poolId, currency)
                == router.totalProtocolClaimed(poolId, currency) + router.protocolClaimable(poolId, currency),
            "PROTOCOL_ACCOUNTING_MISMATCH"
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
