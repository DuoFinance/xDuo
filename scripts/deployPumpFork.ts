import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
import * as fs from "fs";

const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat") {
    if (!getRpcUrl(chain) || !chain.chainId || !chain.deployerPrivateKey) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`
      );
    }
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);

  // 1. Deploy WETH
  const wethOverrides = await buildTxOverrides(ethers.provider, chain, 3_000_000n);
  const WETH = await ethers.getContractFactory("WETH9");
  const weth = await WETH.deploy(wethOverrides);
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  console.log("WETH9:", wethAddress);

  // 2. Deploy Uniswap V2 Factory
  const factoryOverrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const Factory = await ethers.getContractFactory(FACTORY_FQN);
  const factory = await Factory.deploy(deployer.address, factoryOverrides);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory:", factoryAddress);

  // 3. Deploy Uniswap V2 Router
  const routerOverrides = await buildTxOverrides(ethers.provider, chain, 8_000_000n);
  const Router = await ethers.getContractFactory(ROUTER_FQN);
  const router = await Router.deploy(factoryAddress, wethAddress, routerOverrides);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router:", routerAddress);

  // 4. Deploy DuoLaunch (Pump)
  const pumpOverrides = await buildTxOverrides(ethers.provider, chain, 3_000_000n);
  const Pump = await ethers.getContractFactory("contracts/duoLaunch/DuoLaunch.sol:DuoLaunch");
  const pump = await Pump.deploy(factoryAddress, wethAddress, pumpOverrides);
  await pump.waitForDeployment();
  const pumpAddress = await pump.getAddress();
  console.log("DuoLaunch:", pumpAddress);
  console.log("DuoLaunch tx:", pump.deploymentTransaction()?.hash ?? "unknown");

  // 5. Write deployed.json
  const deployed = {
    factory: factoryAddress,
    router: routerAddress,
    pump: pumpAddress,
    wgas: wethAddress,
    staking: "",
  };
  fs.writeFileSync("deployed.json", JSON.stringify(deployed, null, 2));
  console.log("Saved to deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
