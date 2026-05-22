import hre, { ethers } from "hardhat";
import { getRpcUrl, resolveChainByNetwork } from "../config/chains";
import { getEnvByNetwork, requireEnvByNetwork } from "./networkEnv";
import { buildTxOverrides } from "./tx";

type StakingAction =
  | "createPool"
  | "createPoolWithRewards"
  | "startRewards"
  | "fundAndStartRewards"
  | "addRewards"
  | "recoverEndedRewards";

function parseAction(value: string): StakingAction {
  switch (value.trim()) {
    case "createPool":
    case "createPoolWithRewards":
    case "startRewards":
    case "fundAndStartRewards":
    case "addRewards":
    case "recoverEndedRewards":
      return value.trim() as StakingAction;
    default:
      throw new Error(
        `Unsupported staking action "${value}". Expected one of createPool, createPoolWithRewards, startRewards, fundAndStartRewards, addRewards, recoverEndedRewards.`
      );
  }
}

function requireBigInt(networkName: string, key: string): bigint {
  return BigInt(requireEnvByNetwork(networkName, key));
}

function optionalAddress(networkName: string, key: string): string | undefined {
  return getEnvByNetwork(networkName, key);
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

  if (action === "createPool" || action === "createPoolWithRewards") {
    const factoryAddress = requireEnvByNetwork(hre.network.name, "STAKING_FACTORY_ADDRESS");
    const lpToken = requireEnvByNetwork(hre.network.name, "STAKING_LP_TOKEN");
    const rewardToken = requireEnvByNetwork(hre.network.name, "STAKING_REWARD_TOKEN");
    const stakingOwner = optionalAddress(hre.network.name, "STAKING_OWNER") ?? deployer.address;
    const factory = await ethers.getContractAt("DuoSwapStakingFactory", factoryAddress);

    console.log("Factory:", factoryAddress);
    console.log("LP token:", lpToken);
    console.log("Reward token:", rewardToken);
    console.log("Staking owner:", stakingOwner);

    if (action === "createPool") {
      const tx = await factory.createPool(lpToken, rewardToken, stakingOwner, overrides);
      const receipt = await tx.wait();
      let stakingAddress: string | undefined;

      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = factory.interface.parseLog(log);
          if (parsed?.name === "PoolCreated") {
            stakingAddress = parsed.args.staking as string;
            break;
          }
        } catch {
          continue;
        }
      }

      console.log("createPool tx:", tx.hash);
      if (stakingAddress) {
        console.log("Staking:", stakingAddress);
      }
      return;
    }

    const rewardAmount = requireBigInt(hre.network.name, "STAKING_REWARD_AMOUNT");
    const rewardBlocks = requireBigInt(hre.network.name, "STAKING_REWARD_BLOCKS");

    console.log("Reward amount:", rewardAmount.toString());
    console.log("Reward blocks:", rewardBlocks.toString());

    await approveIfNeeded(rewardToken, deployer.address, factoryAddress, rewardAmount, overrides);

    const tx = await factory.createPoolWithRewards(
      lpToken,
      rewardToken,
      stakingOwner,
      rewardAmount,
      rewardBlocks,
      overrides
    );
    const receipt = await tx.wait();
    let stakingAddress: string | undefined;

    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "PoolCreated") {
          stakingAddress = parsed.args.staking as string;
          break;
        }
      } catch {
        continue;
      }
    }

    console.log("createPoolWithRewards tx:", tx.hash);
    if (stakingAddress) {
      console.log("Staking:", stakingAddress);
    }
    return;
  }

  const stakingAddress = requireEnvByNetwork(hre.network.name, "STAKING_ADDRESS");
  const staking = await ethers.getContractAt("DuoSwapStaking", stakingAddress);

  console.log("Staking:", stakingAddress);

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
