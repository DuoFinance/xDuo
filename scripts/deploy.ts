import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
import { deployTokenDeployer } from "./deployTokenDeployer";

const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat") {
    if (!getRpcUrl(chain) || !chain.chainId || !chain.deployerPrivateKey || !chain.wgasAddress) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`
      );
    }
  }

  if (!chain.wgasAddress) {
    throw new Error("Missing WGAS address for router deployment.");
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("WGAS:", chain.wgasAddress);

  const factoryOverrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const routerOverrides = await buildTxOverrides(ethers.provider, chain, 8_000_000n);

  const Factory = await ethers.getContractFactory(FACTORY_FQN);
  const factory = await Factory.deploy(deployer.address, factoryOverrides);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory:", factoryAddress);
  console.log("Factory tx:", factory.deploymentTransaction()?.hash ?? "unknown");

  const Router = await ethers.getContractFactory(ROUTER_FQN);
  const router = await Router.deploy(factoryAddress, chain.wgasAddress, routerOverrides);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router:", routerAddress);
  console.log("Router tx:", router.deploymentTransaction()?.hash ?? "unknown");

  await deployTokenDeployer();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
