import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";

export async function deployWeth() {
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

  const overrides = await buildTxOverrides(ethers.provider, chain, 3_000_000n);
  const WETH = await ethers.getContractFactory("WETH9");
  const weth = await WETH.deploy(overrides);
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress()

  console.log("WETH9:", wethAddress);
  console.log("Deploy tx:", weth.deploymentTransaction()?.hash ?? "unknown");
  return wethAddress
}

// main().catch((error) => {
//   console.error(error);
//   process.exitCode = 1;
// });
