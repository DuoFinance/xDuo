import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";

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

  const factoryOwner = getEnvByNetwork(hre.network.name, "STAKING_FACTORY_OWNER") ?? deployer.address;

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Factory owner:", factoryOwner);

  const overrides = await buildTxOverrides(ethers.provider, chain, 4_000_000n);
  const Factory = await ethers.getContractFactory("DuoSwapStakingFactory");
  const factory = await Factory.deploy(factoryOwner, overrides);
  await factory.waitForDeployment();

  console.log("DuoSwapStakingFactory:", await factory.getAddress());
  console.log("Deploy tx:", factory.deploymentTransaction()?.hash ?? "unknown");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
