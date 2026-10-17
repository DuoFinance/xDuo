import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import { saveDeployedAddresses } from "./xContracts";
import path from "path";
import fs from "fs";
import { deployedPathForNetwork } from "./deployedAddresses";
import { requireContractCode } from "./contractCode";

type DeployedData = {
  FACTORY?: unknown;
  ROUTER?: unknown;
  BONDING?: unknown;
  DUO?: unknown;
  DUOGAS?: unknown;
  STAKING?: unknown;
  [key: string]: unknown;
};

function parseBool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "y"
  );
}

function requireAddress(label: string, value: unknown, deployedJson: string): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(
      `Invalid or missing address for "${label}" in ${path.basename(deployedJson)}. Got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readDeployed(deployedJson: string): DeployedData {
  if (!fs.existsSync(deployedJson)) {
    throw new Error(
      `${path.basename(deployedJson)} not found at ${deployedJson}. Run the base deployment script for this network first.`,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(deployedJson, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${path.basename(deployedJson)}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as DeployedData;
  } catch (err) {
    throw new Error(
      `${path.basename(deployedJson)} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chain = resolveChainByNetwork(hre.network.name);

  if (hre.network.name !== "hardhat" && hre.network.name !== "anvil") {
    if (!getRpcUrl(chain) || !chain.chainId || !chain.deployerPrivateKey) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`,
      );
    }
  }

  const deployedJson = deployedPathForNetwork(hre.network.name);
  const deployed = readDeployed(deployedJson);
  const factoryAddress = requireAddress("FACTORY", deployed.FACTORY, deployedJson);

  const totalSupply = ethers.parseUnits(
    requireEnvByNetwork(hre.network.name, "TOTAL_SUPPLY"),
    18,
  );
  const treasury = requireEnvByNetwork(hre.network.name, "TREASURY_ADDRESS");
  if (!ethers.isAddress(treasury)) {
    throw new Error(`Invalid TREASURY_ADDRESS: ${treasury}`);
  }
  const owner =
    getEnvByNetwork(hre.network.name, "TOKEN_OWNER") ?? deployer.address;
  if (!ethers.isAddress(owner)) {
    throw new Error(`Invalid TOKEN_OWNER: ${owner}`);
  }
  const stakingOwner =
    getEnvByNetwork(hre.network.name, "STAKING_OWNER") ?? deployer.address;
  if (!ethers.isAddress(stakingOwner)) {
    throw new Error(`Invalid STAKING_OWNER: ${stakingOwner}`);
  }
  const rewardBlocks = BigInt(
    getEnvByNetwork(hre.network.name, "STAKING_REWARD_BLOCKS") ?? "0",
  );
  const shouldInitAllocation = parseBool(
    getEnvByNetwork(hre.network.name, "INIT_ALLOCATION"),
  );
  const shouldStartRewards = parseBool(
    getEnvByNetwork(hre.network.name, "INIT_REWARDS"),
  );
  if (!chain.wgasAddress) {
    throw new Error("Missing WGAS address.");
  }
  if (!ethers.isAddress(chain.wgasAddress)) {
    throw new Error(`Invalid chain.wgasAddress: ${chain.wgasAddress}`);
  }
  if (shouldStartRewards && rewardBlocks <= 0n) {
    throw new Error(
      "STAKING_REWARD_BLOCKS must be set when INIT_REWARDS=true.",
    );
  }
  await Promise.all([
    requireContractCode(ethers.provider, factoryAddress, "UniswapV2Factory"),
    requireContractCode(ethers.provider, chain.wgasAddress, "WGAS token"),
  ]);

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log(
    "RPC mode:",
    chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC",
  );
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
  const duoAddress = await token.getAddress();
  await requireContractCode(ethers.provider, duoAddress, "DuoToken");

  console.log("DuoToken:", duoAddress);
  console.log("Deploy tx:", token.deploymentTransaction()?.hash ?? "unknown");

  // 2. Create DUO-WGAS pair on existing UniswapV2Factory
  const factory = await ethers.getContractAt(
    "UniswapV2Factory",
    factoryAddress,
  );
  const createPairTx = await factory.createPair(duoAddress, chain.wgasAddress);
  await createPairTx.wait();
  const DUOGAS: string = await factory.getPair(duoAddress, chain.wgasAddress);
  if (!DUOGAS || DUOGAS === ethers.ZeroAddress) {
    throw new Error(
      `createPair returned zero/empty pair address. tx: ${createPairTx.hash ?? "unknown"}`,
    );
  }
  await requireContractCode(ethers.provider, DUOGAS, "DUO-WGAS pair");
  console.log("DUO-WGAS Pair:", DUOGAS);
  console.log("CreatePair tx:", createPairTx.hash);

  // 3. Deploy DuoSwapStaking for the DUO-WGAS pair
  const Staking = await ethers.getContractFactory("DuoSwapStaking");
  const lpToken = DUOGAS;
  const staking = await Staking.deploy(
    lpToken,
    duoAddress,
    stakingOwner,
    overrides,
  );
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();

  console.log("DuoSwapStaking for %s:", lpToken, stakingAddress);
  console.log(
    "Deploy tx:",
    staking.deploymentTransaction()?.hash ?? "unknown",
  );

  if (shouldInitAllocation) {
    const duoToken = await ethers.getContractAt("DuoToken", duoAddress);
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

  if (hre.network.name !== "hardhat" && hre.network.name !== "anvil") {
    if (!getRpcUrl(chain) || !chain.chainId || !chain.deployerPrivateKey) {
      throw new Error(
        `Missing chain config for network "${hre.network.name}". Check .env network values.`,
      );
    }
  }

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log(
    "RPC mode:",
    chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC",
  );

  //const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);
  const USDT = await ethers.getContractFactory(
    "contracts/duo/MockUSDT.sol:MockUSDT",
  );
  const usdt = await USDT.deploy(overrides);
  await usdt.waitForDeployment();

  const usdtAddress = await usdt.getAddress();
  console.log("MockUSDT:", usdtAddress);
  console.log("Deploy tx:", usdt.deploymentTransaction()?.hash ?? "unknown");
  console.log(
    "Decimals: 4, Total supply: 1000000 USDT (10000000000 base units)",
  );

  // 4. Update the selected network's deployment file.
  saveDeployedAddresses(
    {
      USDT: usdtAddress,
      DUO: duoAddress,
      DUOGAS,
      STAKING: stakingAddress,
    },
    hre.network.name,
  );
  console.log("Saved Duo, USDT, pair, and staking addresses.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
