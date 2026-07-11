import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";
const PUMP_FQN = "contracts/pump/Pump.sol:Pump";

async function deployPump(
  factoryAddress: string,
  wgasAddress: string,
  chain: import("../config/chains").ChainConfig
) {
  const pumpOverrides = await buildTxOverrides(ethers.provider, chain, 3_000_000n);
  const Pump = await ethers.getContractFactory(PUMP_FQN);
  const pump = await Pump.deploy(factoryAddress, wgasAddress, pumpOverrides);
  await pump.waitForDeployment();
  const pumpAddress = await pump.getAddress();
  console.log("Pump:", pumpAddress);
  console.log("Pump tx:", pump.deploymentTransaction()?.hash ?? "unknown");
  return pump;
}

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

  //const weth_Address = await deployWeth();

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

  await deployPump(factoryAddress, chain.wgasAddress, chain);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
