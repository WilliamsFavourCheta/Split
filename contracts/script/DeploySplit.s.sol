// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {SplitStackDeployer} from "./SplitStackDeployer.sol";
import {SplitFactory} from "../src/SplitFactory.sol";
import {SplitHook} from "../src/SplitHook.sol";
import {SplitFeeRouter} from "../src/SplitFeeRouter.sol";
import {SplitLiquidityVault} from "../src/SplitLiquidityVault.sol";

interface VmDeploy {
    function envAddress(string calldata key) external view returns (address);
    function envBool(string calldata key) external view returns (bool);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deliberately guarded deployment entry point. No deployment is run by this task.
contract DeploySplit {
    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    error MainnetNeedsExplicitApproval();
    error TestnetPoolManagerNotOfficial();
    error UnsupportedDeploymentChain(uint256 chainId);
    error WrongMainnetPoolManager(address supplied);
    error PoolManagerHasNoCode();

    function run()
        external
        returns (SplitFactory factory, SplitHook hook, SplitFeeRouter router, SplitLiquidityVault vault)
    {
        // Reject unsupported chains before reading any environment addresses.
        if (block.chainid == 46630) revert TestnetPoolManagerNotOfficial();
        if (block.chainid != 4663 && block.chainid != 31337 && block.chainid != 1337) {
            revert UnsupportedDeploymentChain(block.chainid);
        }

        IPoolManager manager = IPoolManager(vm.envAddress("SPLIT_POOL_MANAGER"));
        address treasury = vm.envAddress("SPLIT_PROTOCOL_TREASURY");
        if (address(manager).code.length == 0) revert PoolManagerHasNoCode();

        // RH testnet currently has no official compatible v4 PoolManager.
        // Never accept a user-supplied address there as a substitute.
        if (block.chainid == 4663) {
            if (address(manager) != 0x8366a39CC670B4001A1121B8F6A443A643e40951) {
                revert WrongMainnetPoolManager(address(manager));
            }
            if (!vm.envBool("ALLOW_RH_MAINNET_DEPLOYMENT")) revert MainnetNeedsExplicitApproval();
        }

        vm.startBroadcast();
        SplitStackDeployer deployer = new SplitStackDeployer();
        bytes32 salt = _findHookSalt(manager, address(deployer));
        (factory, hook, router, vault) = deployer.deploy(manager, treasury, salt);
        vm.stopBroadcast();
    }

    /// @dev Executed in the Forge script's local simulation before broadcast. This is
    ///      deliberately not an on-chain search loop that could consume deployment gas.
    function _findHookSalt(IPoolManager manager, address deployer) private pure returns (bytes32 salt) {
        address routerAddress = _createAddress(deployer, 2);
        address factoryAddress = _createAddress(deployer, 4);
        bytes memory hookCode = abi.encodePacked(
            type(SplitHook).creationCode, abi.encode(manager, factoryAddress, SplitFeeRouter(payable(routerAddress)))
        );
        bytes32 initCodeHash = keccak256(hookCode);
        for (uint256 nonce; nonce < type(uint256).max; ++nonce) {
            salt = bytes32(nonce);
            address predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(predicted) & 0x3fff == 0x44) return salt;
        }
        revert HookSaltNotFound();
    }

    function _createAddress(address deployer, uint8 nonce) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", deployer, bytes1(nonce))))));
    }

    error HookSaltNotFound();
}
