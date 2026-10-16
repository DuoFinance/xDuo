import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { buildTxOverrides } from "./tx";
import { saveDeployedAddresses } from "./xContracts";

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
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const USDT = await ethers.getContractFactory("contracts/duo/MockUSDT.sol:MockUSDT");
  const usdt = await USDT.deploy(overrides);
  await usdt.waitForDeployment();

  const usdtAddress = await usdt.getAddress();
  console.log("MockUSDT:", usdtAddress);
  console.log("Deploy tx:", usdt.deploymentTransaction()?.hash ?? "unknown");
  console.log("Decimals: 4, Total supply: 1000000 USDT (10000000000 base units)");
  saveDeployedAddresses({ USDT: usdtAddress }, hre.network.name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
