import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
import { saveDeployedAddresses, loadDeployedAddresses } from "./xContracts";

const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";
const DUOLAUNCH_FQN = "contracts/duoLaunch/DuoLaunch.sol:DuoLaunch";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat" && hre.network.name !== "anvil") {
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

  // Public networks: re-running `testnet:deploy` / `mainnet:deploy` would
  // deploy a fresh Factory and orphan every pair the previous one knows.
  // Refuse unless the operator explicitly opts in.
  if (
    hre.network.name === "neoxTestnet" ||
    hre.network.name === "neoxMainnet"
  ) {
    const existing = loadDeployedAddresses(hre.network.name);
    if (existing.FACTORY && existing.ROUTER && existing.BONDING) {
      const code = await ethers.provider.getCode(existing.FACTORY);
      if (code && code !== "0x") {
        if (process.env.ALLOW_REDEPLOY !== "1") {
          throw new Error(
            `Refusing to redeploy on ${hre.network.name}: an on-chain trio already exists.\n` +
              `  FACTORY=${existing.FACTORY}\n  ROUTER=${existing.ROUTER}\n  BONDING=${existing.BONDING}\n` +
              `Redeploying creates a new Factory and orphans every existing pair.\n` +
              `Set ALLOW_REDEPLOY=1 to override.`,
          );
        }
        console.warn(
          `[deploy] WARNING: ALLOW_REDEPLOY=1 — replacing the on-chain trio on ${hre.network.name}; old pairs will be orphaned.`,
        );
      }
    }
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

  const saved = saveDeployedAddresses(
    {
      FACTORY: factoryAddress,
      ROUTER: routerAddress,
      BONDING: DuoLaunchAddress,
    },
    hre.network.name,
  );
  console.log("\nSaved deployed contract addresses:");
  console.log(JSON.stringify(saved, null, 2));
  console.log(
    `\nNext: npm run ${hre.network.name === "anvil" ? "anvil" : hre.network.name === "neoxTestnet" ? "testnet" : "mainnet"}:verify, then rebuild/redeploy web and restart the indexer.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
