import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";

function parseBool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function parsePoolConfigs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => entry.split(":")[0].trim());
}

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

  const osTokenAddress = requireEnvByNetwork(hre.network.name, "TOKEN_ADDRESS");
  const stakingOwner = getEnvByNetwork(hre.network.name, "STAKING_OWNER") ?? deployer.address;
  const rewardBlocks = BigInt(getEnvByNetwork(hre.network.name, "STAKING_REWARD_BLOCKS") ?? "0");
  const shouldInitAllocation = parseBool(getEnvByNetwork(hre.network.name, "INIT_ALLOCATION"));
  const shouldStartRewards = parseBool(getEnvByNetwork(hre.network.name, "INIT_REWARDS"));
  const lpTokens = parsePoolConfigs(getEnvByNetwork(hre.network.name, "STAKING_POOLS"));

  if (lpTokens.length === 0) {
    throw new Error("No LP tokens provided in STAKING_POOLS.");
  }
  if (shouldStartRewards && rewardBlocks <= 0n) {
    throw new Error("STAKING_REWARD_BLOCKS must be set when INIT_REWARDS=true.");
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Reward token:", osTokenAddress);
  console.log("Staking owner:", stakingOwner);

  const overrides = await buildTxOverrides(ethers.provider, chain, 5_000_000n);
  const Staking = await ethers.getContractFactory("OnlySwapStaking");

  for (let i = 0; i < lpTokens.length; i += 1) {
    const lpToken = lpTokens[i];
    const staking = await Staking.deploy(lpToken, osTokenAddress, stakingOwner, overrides);
    await staking.waitForDeployment();
    const stakingAddress = await staking.getAddress();

    console.log(`OnlySwapStaking for ${lpToken}:`, stakingAddress);
    console.log("Deploy tx:", staking.deploymentTransaction()?.hash ?? "unknown");

    if (i === 0 && shouldInitAllocation) {
      const osToken = await ethers.getContractAt("OnlySwapToken", osTokenAddress);
      const allocationTx = await osToken.initializeAllocation(stakingAddress, overrides);
      await allocationTx.wait();
      console.log("initializeAllocation tx:", allocationTx.hash);
    }

    if (shouldStartRewards) {
      const rewardTx = await staking.startRewards(rewardBlocks, overrides);
      await rewardTx.wait();
      console.log("startRewards tx:", rewardTx.hash);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
