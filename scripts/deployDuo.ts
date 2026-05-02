import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
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

  const totalSupply = ethers.parseUnits(requireEnvByNetwork(hre.network.name, "TOTAL_SUPPLY"), 18);
  const treasury = requireEnvByNetwork(hre.network.name, "TREASURY_ADDRESS");
  const owner = getEnvByNetwork(hre.network.name, "TOKEN_OWNER") ?? deployer.address;

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Treasury:", treasury);
  console.log("Owner:", owner);
  console.log("Total supply:", ethers.formatUnits(totalSupply, 18));

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const Token = await ethers.getContractFactory("DuoToken");
  const token = await Token.deploy(totalSupply, treasury, owner, overrides);
  await token.waitForDeployment();

  console.log("DuoToken:", await token.getAddress());
  console.log("Deploy tx:", token.deploymentTransaction()?.hash ?? "unknown");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
