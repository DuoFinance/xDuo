import hre, { ethers } from "hardhat";
import { resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import { loadDeployed } from "./liveTest/addresses";
import { saveDeployedAddresses } from "./xContracts";
import { requireContractCode } from "./contractCode";

async function main() {
  if (hre.network.name !== "anvil") {
    throw new Error(
      `This script is for the local Anvil fork; received network "${hre.network.name}".`,
    );
  }

  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);
  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(
      `Connected to chain ${network.chainId}, expected Anvil chain ${chain.chainId}.`,
    );
  }

  const deployed = loadDeployed(hre.network.name);
  if (!ethers.isAddress(deployed.FACTORY)) {
    throw new Error(`Invalid FACTORY address in deployed.anvil.json: ${deployed.FACTORY}`);
  }
  if (!ethers.isAddress(deployed.WGAS)) {
    throw new Error(`Invalid WGAS address in deployed.anvil.json: ${deployed.WGAS}`);
  }

  const totalSupply = ethers.parseUnits(
    requireEnvByNetwork(hre.network.name, "TOTAL_SUPPLY"),
    18,
  );
  const treasury = requireEnvByNetwork(hre.network.name, "TREASURY_ADDRESS");
  const owner = getEnvByNetwork(hre.network.name, "TOKEN_OWNER") ?? deployer.address;
  if (!ethers.isAddress(treasury)) {
    throw new Error(`Invalid TREASURY_ADDRESS: ${treasury}`);
  }
  if (!ethers.isAddress(owner)) {
    throw new Error(`Invalid TOKEN_OWNER: ${owner}`);
  }

  await Promise.all([
    requireContractCode(ethers.provider, deployed.FACTORY, "UniswapV2Factory"),
    requireContractCode(ethers.provider, deployed.WGAS, "WGAS token"),
  ]);

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("Factory:", deployed.FACTORY);
  console.log("WGAS:", deployed.WGAS);
  console.log("Treasury:", treasury);
  console.log("Owner:", owner);
  console.log("Total supply:", ethers.formatUnits(totalSupply, 18));

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const Token = await ethers.getContractFactory("DuoToken");
  const token = await Token.deploy(totalSupply, treasury, owner, overrides);
  await token.waitForDeployment();
  const duoAddress = await token.getAddress();
  await requireContractCode(ethers.provider, duoAddress, "DuoToken");
  console.log("DuoToken:", duoAddress);
  console.log("Deploy tx:", token.deploymentTransaction()?.hash ?? "unknown");

  const factory = await ethers.getContractAt(
    "UniswapV2Factory",
    deployed.FACTORY,
  );
  const createPairTx = await factory.createPair(
    duoAddress,
    deployed.WGAS,
    overrides,
  );
  await createPairTx.wait();
  const duoGasAddress: string = await factory.getPair(duoAddress, deployed.WGAS);
  if (!ethers.isAddress(duoGasAddress) || duoGasAddress === ethers.ZeroAddress) {
    throw new Error(
      `createPair returned invalid DUO-GAS pair address: ${duoGasAddress}`,
    );
  }
  await requireContractCode(ethers.provider, duoGasAddress, "DUO-GAS pair");
  console.log("DUO-GAS pair:", duoGasAddress);
  console.log("Create pair tx:", createPairTx.hash);

  saveDeployedAddresses(
    { DUO: duoAddress, DUOGAS: duoGasAddress },
    hre.network.name,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
