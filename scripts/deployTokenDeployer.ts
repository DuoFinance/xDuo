import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";

export async function deployTokenDeployer() {
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
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const TokenDeployer = await ethers.getContractFactory("DuoTokenDeployer");
  const deployerContract = await TokenDeployer.deploy(overrides);
  await deployerContract.waitForDeployment();

  console.log("DuoTokenDeployer:", await deployerContract.getAddress());
  console.log("Deploy tx:", deployerContract.deploymentTransaction()?.hash ?? "unknown");
}

// main().catch((error) => {
//   console.error(error);
//   process.exitCode = 1;
// });
