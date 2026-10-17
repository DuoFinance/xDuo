import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import { saveDeployedAddresses } from "./xContracts";
import { requireContractCode } from "./contractCode";
import { deployedPathForNetwork } from "./deployedAddresses";
import fs from "fs";
import path from "path";

function parseBool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function readTokenAddresses(networkName: string): {
  duoTokenAddress: string;
  duoGasPairAddress: string;
} {
  const file = deployedPathForNetwork(networkName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read ${path.basename(file)} at ${file}: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path.basename(file)} must contain a JSON object.`);
  }

  const data = parsed as Record<string, unknown>;
  const duoTokenAddress = data.DUO;
  const duoGasPairAddress = data.DUOGAS;
  if (typeof duoTokenAddress !== "string" || !ethers.isAddress(duoTokenAddress)) {
    throw new Error(
      `${path.basename(file)} must contain a valid DUO address; got ${JSON.stringify(duoTokenAddress)}.`,
    );
  }
  if (
    typeof duoGasPairAddress !== "string" ||
    !ethers.isAddress(duoGasPairAddress)
  ) {
    throw new Error(
      `${path.basename(file)} must contain a valid DUOGAS pair address; got ${JSON.stringify(duoGasPairAddress)}.`,
    );
  }
  return { duoTokenAddress, duoGasPairAddress };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat" && hre.network.name !== "anvil") {
    if (!getRpcUrl(chain) || !chain.chainId || !chain.deployerPrivateKey) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`
      );
    }
  }

  const { duoTokenAddress, duoGasPairAddress } = readTokenAddresses(
    hre.network.name,
  );
  const stakingOwner = getEnvByNetwork(hre.network.name, "STAKING_OWNER") ?? deployer.address;
  const rewardBlocks = BigInt(getEnvByNetwork(hre.network.name, "STAKING_REWARD_BLOCKS") ?? "0");
  const shouldInitAllocation = parseBool(getEnvByNetwork(hre.network.name, "INIT_ALLOCATION"));
  const shouldStartRewards = parseBool(getEnvByNetwork(hre.network.name, "INIT_REWARDS"));
  if (shouldStartRewards && rewardBlocks <= 0n) {
    throw new Error("STAKING_REWARD_BLOCKS must be set when INIT_REWARDS=true.");
  }

  await Promise.all([
    requireContractCode(ethers.provider, duoTokenAddress, "reward token"),
    requireContractCode(ethers.provider, duoGasPairAddress, "DUO-GAS pair"),
  ]);

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Reward token:", duoTokenAddress);
  console.log("Staking owner:", stakingOwner);

  const overrides = await buildTxOverrides(ethers.provider, chain, 5_000_000n);
  const Staking = await ethers.getContractFactory("DuoSwapStaking");
  const lpToken = duoGasPairAddress;
  const staking = await Staking.deploy(
    lpToken,
    duoTokenAddress,
    stakingOwner,
    overrides,
  );
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();

  console.log("DuoSwapStaking for %s:", lpToken, stakingAddress);
  console.log("Deploy tx:", staking.deploymentTransaction()?.hash ?? "unknown");

  if (shouldInitAllocation) {
    const duoToken = await ethers.getContractAt("DuoToken", duoTokenAddress);
    const allocationTx = await duoToken.initializeAllocation(
      stakingAddress,
      overrides,
    );
    await allocationTx.wait();
    console.log("initializeAllocation tx:", allocationTx.hash);
  }

  if (shouldStartRewards) {
    const rewardTx = await staking.startRewards(rewardBlocks, overrides);
    await rewardTx.wait();
    console.log("startRewards tx:", rewardTx.hash);
  }
  saveDeployedAddresses({ STAKING: stakingAddress }, hre.network.name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
