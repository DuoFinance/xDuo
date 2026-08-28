import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

const DEPLOYED_JSON = path.resolve(__dirname, "..", "deployed.json");
const DEPLOYED_JSON_TMP = `${DEPLOYED_JSON}.tmp`;
const DEPLOYED_JSON_BAK = `${DEPLOYED_JSON}.bak`;

type DeployedData = {
  FACTORY?: unknown;
  ROUTER?: unknown;
  BONDING?: unknown;
  DUO?: unknown;
  PAIR?: unknown;
  STAKING?: unknown;
  [key: string]: unknown;
};

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

function requireAddress(label: string, value: unknown): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(
      `Invalid or missing address for "${label}" in deployed.json. Got: ${JSON.stringify(value)}`
    );
  }
  return value;
}

function readDeployed(): DeployedData {
  if (!existsSync(DEPLOYED_JSON)) {
    throw new Error(
      `deployed.json not found at ${DEPLOYED_JSON}. Run the base deployment script first.`
    );
  }
  let raw: string;
  try {
    raw = readFileSync(DEPLOYED_JSON, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read deployed.json: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as DeployedData;
  } catch (err) {
    throw new Error(`deployed.json is not valid JSON: ${(err as Error).message}`);
  }
}

function atomicWriteDeployed(data: DeployedData): void {
  const payload = JSON.stringify(data, null, 2) + "\n";
  // 1) 
  writeFileSync(DEPLOYED_JSON_TMP, payload, "utf-8");
  // 2) （）
  if (existsSync(DEPLOYED_JSON)) {
    copyFileSync(DEPLOYED_JSON, DEPLOYED_JSON_BAK);
  }
  // 3) （ rename ）
  renameSync(DEPLOYED_JSON_TMP, DEPLOYED_JSON);
}

function warnIfOverwrite(label: string, existing: unknown, next: unknown): void {
  if (
    existing !== undefined &&
    existing !== null &&
    existing !== "" &&
    existing !== next
  ) {
    console.warn(
      `[WARN] Overwriting deployed.json["${label}"]: ${JSON.stringify(existing)} → ${JSON.stringify(next)}`
    );
  }
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

  const deployed = readDeployed();
  const factoryAddress = requireAddress("FACTORY", deployed.FACTORY);

  const totalSupply = ethers.parseUnits(requireEnvByNetwork(hre.network.name, "TOTAL_SUPPLY"), 18);
  const treasury = requireEnvByNetwork(hre.network.name, "TREASURY_ADDRESS");
  if (!ethers.isAddress(treasury)) {
    throw new Error(`Invalid TREASURY_ADDRESS: ${treasury}`);
  }
  const owner = getEnvByNetwork(hre.network.name, "TOKEN_OWNER") ?? deployer.address;
  if (!ethers.isAddress(owner)) {
    throw new Error(`Invalid TOKEN_OWNER: ${owner}`);
  }
  const stakingOwner = getEnvByNetwork(hre.network.name, "STAKING_OWNER") ?? deployer.address;
  if (!ethers.isAddress(stakingOwner)) {
    throw new Error(`Invalid STAKING_OWNER: ${stakingOwner}`);
  }
  const rewardBlocks = BigInt(getEnvByNetwork(hre.network.name, "STAKING_REWARD_BLOCKS") ?? "0");
  const shouldInitAllocation = parseBool(getEnvByNetwork(hre.network.name, "INIT_ALLOCATION"));
  const shouldStartRewards = parseBool(getEnvByNetwork(hre.network.name, "INIT_REWARDS"));
  const lpTokens = parsePoolConfigs(getEnvByNetwork(hre.network.name, "STAKING_POOLS"));

  if (!chain.wgasAddress) {
    throw new Error("Missing WGAS address.");
  }
  if (!ethers.isAddress(chain.wgasAddress)) {
    throw new Error(`Invalid chain.wgasAddress: ${chain.wgasAddress}`);
  }
  for (const lpToken of lpTokens) {
    if (!ethers.isAddress(lpToken)) {
      throw new Error(`Invalid LP token address in STAKING_POOLS: ${lpToken}`);
    }
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Treasury:", treasury);
  console.log("Owner:", owner);
  console.log("Total supply:", ethers.formatUnits(totalSupply, 18));
  console.log("WGAS:", chain.wgasAddress);
  console.log("Factory:", factoryAddress);
  console.log("STAKING_POOLS count:", lpTokens.length);

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
  if (!pairAddress || pairAddress === ethers.ZeroAddress) {
    throw new Error(
      `createPair returned zero/empty pair address. tx: ${createPairTx.hash ?? "unknown"}`
    );
  }
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

  // 4. Update deployed.json with new addresses (uppercase keys match existing schema)
  const stakingValue = stakingAddresses.join(",");
  warnIfOverwrite("DUO", deployed.DUO, tokenAddress);
  warnIfOverwrite("PAIR", deployed.PAIR, pairAddress);
  warnIfOverwrite("STAKING", deployed.STAKING, stakingValue);

  deployed.DUO = tokenAddress;
  deployed.PAIR = pairAddress;
  deployed.STAKING = stakingValue;
  atomicWriteDeployed(deployed);
  console.log("Saved (atomically) to deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});