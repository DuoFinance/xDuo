import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";
import fs from "fs";
import path from "path";

type StakingAction =
  | "startRewards"
  | "fundAndStartRewards"
  | "addRewards"
  | "recoverEndedRewards";

const DEPLOYED_JSON = path.resolve(__dirname, "..", "deployed.json");

function parseAction(value: string): StakingAction {
  switch (value.trim()) {
    case "startRewards":
    case "fundAndStartRewards":
    case "addRewards":
    case "recoverEndedRewards":
      return value.trim() as StakingAction;
    default:
      throw new Error(
        `Unsupported staking action "${value}". Expected one of startRewards, fundAndStartRewards, addRewards, recoverEndedRewards.`
      );
  }
}

function readDeployedAddresses(): { staking: string; duoGas: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(DEPLOYED_JSON, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read deployed.json at ${DEPLOYED_JSON}: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid deployed.json at ${DEPLOYED_JSON}: expected an object.`);
  }

  const data = parsed as Record<string, unknown>;
  const staking = data.STAKING;
  const duoGas = data.DUOGAS;
  if (typeof staking !== "string" || !ethers.isAddress(staking.trim())) {
    throw new Error(
      `deployed.json must contain one valid STAKING address; got ${JSON.stringify(staking)}.`,
    );
  }
  if (typeof duoGas !== "string" || !ethers.isAddress(duoGas.trim())) {
    throw new Error(
      `deployed.json must contain one valid DUOGAS address; got ${JSON.stringify(duoGas)}.`,
    );
  }

  return { staking: staking.trim(), duoGas: duoGas.trim() };
}

function requireBigInt(networkName: string, key: string): bigint {
  return BigInt(requireEnvByNetwork(networkName, key));
}

async function approveIfNeeded(
  tokenAddress: string,
  ownerAddress: string,
  spender: string,
  amount: bigint,
  overrides: Awaited<ReturnType<typeof buildTxOverrides>>
) {
  const token = await ethers.getContractAt(
    [
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)"
    ],
    tokenAddress
  );
  const allowance = await token.allowance(ownerAddress, spender);
  if (allowance >= amount) {
    console.log("Allowance already sufficient:", allowance.toString());
    return;
  }

  const approvalTx = await token.approve(spender, amount, overrides);
  await approvalTx.wait();
  console.log("approve tx:", approvalTx.hash);
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

  const action = parseAction(requireEnvByNetwork(hre.network.name, "STAKING_ACTION"));
  const overrides = await buildTxOverrides(ethers.provider, chain, 6_000_000n);

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("RPC mode:", chain.antiMevRpcUrl ? "anti-mev/private RPC" : "standard RPC");
  console.log("Action:", action);

  const { staking: stakingAddress, duoGas: configuredDuoGas } =
    readDeployedAddresses();
  const staking = await ethers.getContractAt("DuoSwapStaking", stakingAddress);
  const [stakingOwner, stakingLpToken] = await Promise.all([
    staking.owner(),
    staking.lpToken(),
  ]);
  if (stakingOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Wallet ${deployer.address} is not the owner of staking contract ${stakingAddress} (owner: ${stakingOwner}).`,
    );
  }
  if (stakingLpToken.toLowerCase() !== configuredDuoGas.toLowerCase()) {
    throw new Error(
      `DUOGAS in deployed.json (${configuredDuoGas}) does not match staking contract LP token (${stakingLpToken}).`,
    );
  }

  console.log("Staking:", stakingAddress);
  console.log("DUOGAS:", configuredDuoGas);
  console.log("Staking owner:", stakingOwner);

  if (action === "startRewards") {
    const rewardBlocks = requireBigInt(hre.network.name, "STAKING_REWARD_BLOCKS");
    console.log("Reward blocks:", rewardBlocks.toString());

    const tx = await staking.startRewards(rewardBlocks, overrides);
    await tx.wait();
    console.log("startRewards tx:", tx.hash);
    return;
  }

  if (action === "fundAndStartRewards" || action === "addRewards") {
    const rewardAmount = requireBigInt(hre.network.name, "STAKING_REWARD_AMOUNT");
    const rewardBlocks = requireBigInt(hre.network.name, "STAKING_REWARD_BLOCKS");
    const rewardToken = await staking.rewardToken();

    console.log("Reward token:", rewardToken);
    console.log("Reward amount:", rewardAmount.toString());
    console.log("Reward blocks:", rewardBlocks.toString());

    await approveIfNeeded(rewardToken, deployer.address, stakingAddress, rewardAmount, overrides);

    const tx =
      action === "fundAndStartRewards"
        ? await staking.fundAndStartRewards(rewardAmount, rewardBlocks, overrides)
        : await staking.addRewards(rewardAmount, rewardBlocks, overrides);
    await tx.wait();
    console.log('%s tx:', action, tx.hash);
    return;
  }

  const recoveryTo = requireEnvByNetwork(hre.network.name, "STAKING_RECOVERY_TO");
  const recoveryAmount = requireBigInt(hre.network.name, "STAKING_RECOVERY_AMOUNT");

  console.log("Recovery to:", recoveryTo);
  console.log("Recovery amount:", recoveryAmount.toString());

  const tx = await staking.recoverEndedRewards(recoveryTo, recoveryAmount, overrides);
  await tx.wait();
  console.log("recoverEndedRewards tx:", tx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
