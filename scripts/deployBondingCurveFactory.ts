import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";

export async function deployBondingCurveFactory() {
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

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const Factory = await ethers.getContractFactory("DuoBondingCurveFactory");
  const factory = await Factory.deploy(overrides);
  await factory.waitForDeployment();

  console.log("DuoBondingCurveFactory:", await factory.getAddress());
  console.log("Deploy tx:", factory.deploymentTransaction()?.hash ?? "unknown");
}
