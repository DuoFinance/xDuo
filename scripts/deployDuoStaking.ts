import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

const DEPLOYED_JSON = path.resolve(__dirname, "..", "deployed.json");

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

  const deployed = JSON.parse(readFileSync(DEPLOYED_JSON, "utf-8"));
  const factoryAddress = deployed.factory;
  if (!factoryAddress) {
    throw new Error("Missing factory address in deployed.json. Please deploy the factory first.");
  }

  const totalSupply = ethers.parseUnits(requireEnvByNetwork(hre.network.name, "TOTAL_SUPPLY"), 18);
  const treasury = requireEnvByNetwork(hre.network.name, "TREASURY_ADDRESS");
  const owner = getEnvByNetwork(hre.network.name, "TOKEN_OWNER") ?? deployer.address;
  const stakingOwner = getEnvByNetwork(hre.network.name, "STAKING_OWNER") ?? deployer.address;
  const rewardBlocks = BigInt(getEnvByNetwork(hre.network.name, "STAKING_REWARD_BLOCKS") ?? "0");
  const shouldInitAllocation = parseBool(getEnvByNetwork(hre.network.name, "INIT_ALLOCATION"));
  const shouldStartRewards = parseBool(getEnvByNetwork(hre.network.name, "INIT_REWARDS"));
  const lpTokens = parsePoolConfigs(getEnvByNetwork(hre.network.name, "STAKING_POOLS"));

  if (!chain.wgasAddress) {
    throw new Error("Missing WGAS address.");
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Treasury:", treasury);
  console.log("Owner:", owner);
  console.log("Total supply:", ethers.formatUnits(totalSupply, 18));
  console.log("WGAS:", chain.wgasAddress);
  console.log("Factory:", factoryAddress);

  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);

  // 1. Deploy DuoToken
  const Token = await ethers.getContractFactory("DuoToken");
  const token = await Token.deploy(totalSupply, treasury, owner, overrides);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  console.log("DuoToken:", tokenAddress);
  console.log("Deploy tx:", token.deploymentTransaction()?.hash ?? "unknown");

  // 2. Create DUO-WGAS pair on existing UniswapV2Factory
  const factory = await ethers.getContractAt("UniswapV2Factory", factoryAddress);
  const createPairTx = await factory.createPair(tokenAddress, chain.wgasAddress);
  await createPairTx.wait();
  const pairAddress = await factory.getPair(tokenAddress, chain.wgasAddress);
  console.log("DUO-WGAS Pair:", pairAddress);
  console.log("CreatePair tx:", createPairTx.hash);

  // 3. Deploy DuoSwapStaking for each LP token
  if (lpTokens.length === 0) {
    throw new Error("No LP tokens provided in STAKING_POOLS.");
  }
  if (shouldStartRewards && rewardBlocks <= 0n) {
    throw new Error("STAKING_REWARD_BLOCKS must be set when INIT_REWARDS=true.");
  }

  const Staking = await ethers.getContractFactory("DuoSwapStaking");
  const stakingAddresses: string[] = [];

  for (let i = 0; i < lpTokens.length; i += 1) {
    const lpToken = lpTokens[i];
    const staking = await Staking.deploy(lpToken, tokenAddress, stakingOwner, overrides);
    await staking.waitForDeployment();
    const stakingAddress = await staking.getAddress();
    stakingAddresses.push(stakingAddress);

    console.log('DuoSwapStaking for %s:', lpToken, stakingAddress);
    console.log("Deploy tx:", staking.deploymentTransaction()?.hash ?? "unknown");

    if (i === 0 && shouldInitAllocation) {
      const duoToken = await ethers.getContractAt("DuoToken", tokenAddress);
      const allocationTx = await duoToken.initializeAllocation(stakingAddress, overrides);
      await allocationTx.wait();
      console.log("initializeAllocation tx:", allocationTx.hash);
    }

    if (shouldStartRewards) {
      const rewardTx = await staking.startRewards(rewardBlocks, overrides);
      await rewardTx.wait();
      console.log("startRewards tx:", rewardTx.hash);
    }
  }

  // 4. Update deployed.json with new addresses
  deployed.Duo = tokenAddress;
  deployed.Pair = pairAddress;
  deployed.Staking = stakingAddresses.join(",");
  writeFileSync(DEPLOYED_JSON, JSON.stringify(deployed, null, 2));
  console.log("Saved to deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});