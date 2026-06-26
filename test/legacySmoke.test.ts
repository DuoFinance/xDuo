import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  DuoTokenDeployer,
  DuoSwapStaking,
  DuoSwapStakingFactory,
  DuoToken,
  UniswapV2Factory,
  UniswapV2Router02
} from "../typechain-types";
import {
  DuoTokenDeployer__factory,
  DuoSwapStaking__factory,
  DuoSwapStakingFactory__factory,
  DuoToken__factory,
  UniswapV2Factory__factory,
  UniswapV2Router02__factory
} from "../typechain-types";

describe("Uni2 legacy NeoX smoke", function () {
  it("deploys core router plus auxiliary contracts", async function () {
    const [owner, treasury, user] = await ethers.getSigners();

    const duoToken: DuoToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      treasury.address,
      owner.address
    );
    await duoToken.waitForDeployment();

    const factory: UniswapV2Factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router: UniswapV2Router02 = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(),
      await duoToken.getAddress()
    );
    await router.waitForDeployment();

    expect(await factory.feeToSetter()).to.equal(owner.address);
    expect(await router.factory()).to.equal(await factory.getAddress());

    const staking: DuoSwapStaking = await new DuoSwapStaking__factory(owner).deploy(
      await duoToken.getAddress(),
      await duoToken.getAddress(),
      owner.address
    );
    await staking.waitForDeployment();

    await duoToken.initializeAllocation(await staking.getAddress());
    await duoToken.connect(treasury).transfer(user.address, ethers.parseEther("1000"));
    await staking.startRewards(10n);

    await duoToken.connect(user).approve(await staking.getAddress(), ethers.parseEther("100"));
    await staking.connect(user).deposit(ethers.parseEther("100"));
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);

    expect(await staking.totalStaked()).to.equal(ethers.parseEther("100"));
    expect(await staking.pendingReward(user.address)).to.be.gt(0n);

    const tokenDeployer: DuoTokenDeployer = await new DuoTokenDeployer__factory(owner).deploy();
    await tokenDeployer.waitForDeployment();

    await tokenDeployer.deployToken(
      "Smoke",
      "SMK",
      18,
      ethers.parseEther("1000"),
      "tester",
      "smoke"
    );

    expect(await tokenDeployer.getTokenCount()).to.equal(1n);
  });

  it("funds and starts rewards for a new pool in one tx", async function () {
    const [owner, treasury] = await ethers.getSigners();

    const osToken: DuoToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      treasury.address,
      owner.address
    );
    await osToken.waitForDeployment();

    const staking: DuoSwapStaking = await new DuoSwapStaking__factory(owner).deploy(
      await osToken.getAddress(),
      await osToken.getAddress(),
      owner.address
    );
    await staking.waitForDeployment();

    const rewardAmount = ethers.parseEther("100");
    await osToken.initializeAllocation(await staking.getAddress());
    await osToken.connect(treasury).transfer(owner.address, rewardAmount);
    await osToken.approve(await staking.getAddress(), rewardAmount);
    await staking.addRewardsForNewPool(rewardAmount, 10n);

    expect(await staking.rewardsStarted()).to.equal(true);
    expect(await staking.rewardPerBlock()).to.equal(ethers.parseEther("50010"));
  });

  it("adds rewards to an existing pool and refreshes the schedule", async function () {
    const [owner, treasury] = await ethers.getSigners();

    const osToken: DuoToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      treasury.address,
      owner.address
    );
    await osToken.waitForDeployment();

    const staking: DuoSwapStaking = await new DuoSwapStaking__factory(owner).deploy(
      await osToken.getAddress(),
      await osToken.getAddress(),
      owner.address
    );
    await staking.waitForDeployment();

    await osToken.initializeAllocation(await staking.getAddress());
    await staking.startRewards(10n);
    const previousRewardPerBlock = await staking.rewardPerBlock();
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);

    const extraReward = ethers.parseEther("50");
    await osToken.connect(treasury).transfer(owner.address, extraReward);
    await osToken.approve(await staking.getAddress(), extraReward);
    await staking.addRewardsForExistingPool(extraReward, 5n);

    expect(await staking.rewardPerBlock()).to.be.gt(previousRewardPerBlock);
    expect(await staking.rewardEndBlock()).to.equal((await ethers.provider.getBlockNumber()) + 5);
  });

  it("creates a new pool with explicit params and starts rewards in one flow", async function () {
    const [owner, , poolOwner] = await ethers.getSigners();

    const osToken: DuoToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      owner.address,
      owner.address
    );
    await osToken.waitForDeployment();
    await osToken.initializeAllocation(poolOwner.address);

    const factory: DuoSwapStakingFactory = await new DuoSwapStakingFactory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const rewardAmount = ethers.parseEther("100");
    await osToken.approve(await factory.getAddress(), rewardAmount);

    const tx = await factory.createPoolWithRewards(
      await osToken.getAddress(),
      await osToken.getAddress(),
      poolOwner.address,
      rewardAmount,
      10n
    );
    const receipt = await tx.wait();
    const poolCreatedLog = receipt!.logs
      .map((log:any) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed:any) => parsed?.name === "PoolCreated");

    const stakingAddress = poolCreatedLog!.args.staking as string;
    const staking = DuoSwapStaking__factory.connect(stakingAddress, owner);

    expect(await staking.lpToken()).to.equal(await osToken.getAddress());
    expect(await staking.rewardToken()).to.equal(await osToken.getAddress());
    expect(await staking.owner()).to.equal(poolOwner.address);
    expect(await staking.rewardsStarted()).to.equal(true);
    expect(await staking.rewardEndBlock()).to.equal((await ethers.provider.getBlockNumber()) + 10);
  });
});
