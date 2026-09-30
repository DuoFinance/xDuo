import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
import { saveXContracts } from "./xContracts";
import path from "path";
import fs from "fs";

const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";
const DUOLAUNCH_FQN = "contracts/duoLaunch/DuoLaunch.sol:DuoLaunch";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat") {
    if (
      !getRpcUrl(chain) ||
      !chain.chainId ||
      !chain.deployerPrivateKey ||
      !chain.wgasAddress
    ) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`,
      );
    }
  }

  if (!chain.wgasAddress) {
    throw new Error("Missing WGAS address for router deployment.");
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log(
    "RPC mode:",
    chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC",
  );
  console.log("WGAS:", chain.wgasAddress);

  const factoryOverrides = await buildTxOverrides(
    ethers.provider,
    chain,
    6_000_000n,
  );
  const routerOverrides = await buildTxOverrides(
    ethers.provider,
    chain,
    8_000_000n,
  );

  const Factory = await ethers.getContractFactory(FACTORY_FQN);
  const factory = await Factory.deploy(deployer.address, factoryOverrides);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory:", factoryAddress);
  console.log(
    "Factory tx:",
    factory.deploymentTransaction()?.hash ?? "unknown",
  );

  const Router = await ethers.getContractFactory(ROUTER_FQN);
  const router = await Router.deploy(
    factoryAddress,
    chain.wgasAddress,
    routerOverrides,
  );
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router:", routerAddress);
  console.log("Router tx:", router.deploymentTransaction()?.hash ?? "unknown");

  // deploy duoLaunch.cs
  const LaunchOverrides = await buildTxOverrides(
    ethers.provider,
    chain,
    3_000_000n,
  );
  const Launch = await ethers.getContractFactory(DUOLAUNCH_FQN);
  const LaunchRes = await Launch.deploy(
    factoryAddress,
    chain.wgasAddress,
    LaunchOverrides,
  );
  await LaunchRes.waitForDeployment();
  const DuoLaunchAddress = await LaunchRes.getAddress();
  console.log("DuoLaunch:", DuoLaunchAddress);
  console.log("tx:", LaunchRes.deploymentTransaction()?.hash ?? "unknown");

  // Write deployed addresses to deployed.json (merge — never wipe keys
  // written by other deploy scripts such as USDT/DUO/STAKING).
  const contractsPath = path.resolve(__dirname, "..", "deployed.json");
  let existingDeployed: Record<string, unknown> = {};
  try {
    existingDeployed = JSON.parse(fs.readFileSync(contractsPath, "utf-8"));
  } catch {
    existingDeployed = {};
  }
  const saved = {
    ...(existingDeployed && typeof existingDeployed === "object"
      ? existingDeployed
      : {}),
    FACTORY: factoryAddress,
    ROUTER: routerAddress,
    BONDING: DuoLaunchAddress,
  };

  fs.writeFileSync(contractsPath, JSON.stringify(saved, null, 2) + "\n");
  console.log(
    `\n[deploy Factory, Router, DuoLaunch] Saved Factory, Router, DuoLaunch contract addresses to ${contractsPath}`,
  );
  console.log(JSON.stringify(saved, null, 2));

  // Sync to ui-v2/packages/config/src/deployedContracts/ (per-mode + legacy).
  // Merge-only: keys from other scripts (USDT/DUO/...) are preserved.
  saveXContracts(
    {
      FACTORY: factoryAddress,
      ROUTER: routerAddress,
      BONDING: DuoLaunchAddress,
    },
    hre.network.name,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
