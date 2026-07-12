import { expect } from "chai";
import { ethers } from "hardhat";
import type { DuoSwapStaking, DuoToken } from "../typechain-types";
import { DuoSwapStaking__factory, DuoToken__factory } from "../typechain-types";

describe("DuoSwapStaking — static functions", function () {
  let owner: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let treasury: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let user: NonNullable<Awaited<ReturnType<typeof ethers.getSigners>>[number]>;
  let staking: DuoSwapStaking;
  let lpToken: DuoToken;
  let rewardToken: DuoToken;

  async function initRewards(stakingAddr: string, amount: bigint) {
    await rewardToken.initializeAllocation(owner.address);
    const treasuryAddr = await rewardToken.treasury();
    const treasurySigner = await ethers.getSigner(treasuryAddr);
    await rewardToken.connect(treasurySigner).transfer(stakingAddr, amount);
  }

  async function fundUserLp(amount: bigint) {
    await lpToken.initializeAllocation(owner.address);
    const treasuryAddr = await lpToken.treasury();
    const treasurySigner = await ethers.getSigner(treasuryAddr);
    await lpToken.connect(treasurySigner).transfer(user.address, amount);
    await lpToken.connect(user).approve(await staking.getAddress(), amount);
  }

  beforeEach(async function () {
    [owner, , user] = await ethers.getSigners();

    lpToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      owner.address,
      owner.address
    );
    await lpToken.waitForDeployment();

    rewardToken = await new DuoToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      owner.address,
      owner.address
    );
    await rewardToken.waitForDeployment();

    staking = await new DuoSwapStaking__factory(owner).deploy(
      await lpToken.getAddress(),
      await rewardToken.getAddress(),
      owner.address
    );
    await staking.waitForDeployment();
  });

  describe("lpToken", function () {
    it("returns the LP token address from constructor", async function () {
      expect(await staking.lpToken()).to.equal(await lpToken.getAddress());
    });
  });

  describe("rewardToken", function () {
    it("returns the reward token address from constructor", async function () {
      expect(await staking.rewardToken()).to.equal(await rewardToken.getAddress());
    });
  });

  describe("owner", function () {
    it("returns the owner address from constructor", async function () {
      expect(await staking.owner()).to.equal(owner.address);
    });
  });

  describe("totalStaked", function () {
    it("returns 0 initially", async function () {
      expect(await staking.totalStaked()).to.equal(0n);
    });

    it("increases after deposit", async function () {
      await fundUserLp(ethers.parseEther("100"));
      await staking.connect(user).deposit(ethers.parseEther("100"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("100"));
    });

    it("decreases after withdraw", async function () {
      await fundUserLp(ethers.parseEther("100"));
      await staking.connect(user).deposit(ethers.parseEther("100"));
      await staking.connect(user).withdraw(ethers.parseEther("60"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("40"));
    });
  });

  describe("rewardsStarted", function () {
    it("returns false initially", async function () {
      expect(await staking.rewardsStarted()).to.equal(false);
    });

    it("returns true after startRewards", async function () {
      await initRewards(await staking.getAddress(), ethers.parseEther("1000"));
      await staking.startRewards(10n);
      expect(await staking.rewardsStarted()).to.equal(true);
    });
  });

  describe("rewardPerBlock", function () {
    it("returns 0 before rewards start", async function () {
      expect(await staking.rewardPerBlock()).to.equal(0n);
    });

    it("returns computed per-block reward", async function () {
      const totalReward = ethers.parseEther("1000");
      const blocks = 10n;
      await initRewards(await staking.getAddress(), totalReward);
      await staking.startRewards(blocks);
      expect(await staking.rewardPerBlock()).to.equal(totalReward / blocks);
    });
  });

  describe("rewardEndBlock", function () {
    it("returns 0 before rewards start", async function () {
      expect(await staking.rewardEndBlock()).to.equal(0n);
    });

    it("returns block.number + rewardBlocks after startRewards", async function () {
      const totalReward = ethers.parseEther("1000");
      const blocks = 10n;
      await initRewards(await staking.getAddress(), totalReward);
      await staking.startRewards(blocks);
      expect(await staking.rewardEndBlock()).to.equal(
        (await ethers.provider.getBlockNumber()) + Number(blocks)
      );
    });
  });

  describe("lastRewardBlock", function () {
    it("returns 0 before rewards start", async function () {
      expect(await staking.lastRewardBlock()).to.equal(0n);
    });
  });

  describe("accRewardPerShare", function () {
    it("returns 0 before rewards start", async function () {
      expect(await staking.accRewardPerShare()).to.equal(0n);
    });
  });

  describe("pendingReward", function () {
    it("returns 0 for users with no stake", async function () {
      expect(await staking.pendingReward(user.address)).to.equal(0n);
    });

    it("returns > 0 after staking and mining blocks", async function () {
      await initRewards(await staking.getAddress(), ethers.parseEther("1000"));
      await staking.startRewards(100n);

      await fundUserLp(ethers.parseEther("100"));
      await staking.connect(user).deposit(ethers.parseEther("100"));

      await ethers.provider.send("evm_mine", []);

      const pending = await staking.pendingReward(user.address);
      expect(pending).to.be.gt(0n);
    });
  });

  describe("userInfo", function () {
    it("returns zero amount and rewardDebt for non-stakers", async function () {
      const info = await staking.userInfo(user.address);
      expect(info.amount).to.equal(0n);
      expect(info.rewardDebt).to.equal(0n);
    });

    it("returns correct amount after deposit", async function () {
      await fundUserLp(ethers.parseEther("100"));
      await staking.connect(user).deposit(ethers.parseEther("100"));

      const info = await staking.userInfo(user.address);
      expect(info.amount).to.equal(ethers.parseEther("100"));
    });
  });
});
