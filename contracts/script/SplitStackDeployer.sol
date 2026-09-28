// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {SplitHook} from "../src/SplitHook.sol";
import {SplitFeeRouter} from "../src/SplitFeeRouter.sol";
import {SplitLiquidityVault} from "../src/SplitLiquidityVault.sol";
import {SplitFactory} from "../src/SplitFactory.sol";

/// @notice Deploys a mutually-referencing immutable protocol stack with no post-deploy admin.
contract SplitStackDeployer {
    uint160 private constant HOOK_MASK = 0x3fff;
    uint160 private constant HOOK_FLAGS = 0x2044;

    error HookDeploymentFailed();
    error DeploymentAddressMismatch();
    error InvalidHookSalt();
    error UnauthorizedDeployer(address caller);
    error AlreadyDeployed();
    error InvalidConfiguration();

    address public immutable authorizedDeployer;
    IPoolManager public immutable expectedPoolManager;
    address public immutable protocolTreasury;
    bool public deployed;

    event StackDeployed(address factory, address hook, address router, address vault, address poolManager);

    /// @notice Bind the helper to its deployer and intended immutable configuration
    /// before it is published. A front-runner cannot substitute a manager or treasury.
    constructor(IPoolManager manager, address treasury) {
        if (address(manager) == address(0) || address(manager).code.length == 0 || treasury == address(0)) {
            revert InvalidConfiguration();
        }
        authorizedDeployer = msg.sender;
        expectedPoolManager = manager;
        protocolTreasury = treasury;
    }

    function deploy(bytes32 salt)
        public
        returns (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault)
    {
        if (msg.sender != authorizedDeployer) revert UnauthorizedDeployer(msg.sender);
        if (deployed) revert AlreadyDeployed();
        deployed = true;
        IPoolManager manager = expectedPoolManager;
        address treasury = protocolTreasury;
        address vaultAddress = _createAddress(address(this), 1);
        address routerAddress = _createAddress(address(this), 2);
        // CREATE2 advances this contract's nonce too, so factory is CREATE nonce four.
        address factoryAddress = _createAddress(address(this), 4);
        bytes memory hookCode = abi.encodePacked(
            type(SplitHook).creationCode, abi.encode(manager, factoryAddress, SplitFeeRouter(payable(routerAddress)))
        );
        bytes32 initCodeHash = keccak256(hookCode);
        address hookAddress =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
        if (uint160(hookAddress) & HOOK_MASK != HOOK_FLAGS) revert InvalidHookSalt();

        vault = new SplitLiquidityVault(factoryAddress, routerAddress, manager);
        router = new SplitFeeRouter(factoryAddress, hookAddress, vault, treasury);
        address deployedHook;
        assembly ("memory-safe") {
            deployedHook := create2(0, add(hookCode, 0x20), mload(hookCode), salt)
        }
        if (deployedHook != hookAddress || deployedHook.code.length == 0) revert HookDeploymentFailed();
        hook = SplitHook(payable(deployedHook));
        factory = new SplitFactory(manager, hook, router, vault, treasury);
        if (
            address(vault) != vaultAddress || address(router) != routerAddress || address(factory) != factoryAddress
                || uint160(address(hook)) & HOOK_MASK != HOOK_FLAGS
        ) revert DeploymentAddressMismatch();
        emit StackDeployed(address(factory), address(hook), address(router), address(vault), address(manager));
    }

    function _createAddress(address deployer, uint8 nonce) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", deployer, bytes1(nonce))))));
    }
}
