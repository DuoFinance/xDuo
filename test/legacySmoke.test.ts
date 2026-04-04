import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  EvmTokenDeployer,
  OnlySwapStaking,
  OnlySwapToken,
  UniswapV2Factory,
  UniswapV2Router02
} from "../typechain-types";
import {
  EvmTokenDeployer__factory,
  OnlySwapStaking__factory,
  OnlySwapToken__factory,
  UniswapV2Factory__factory,
  UniswapV2Router02__factory
} from "../typechain-types";

describe("Uni2 legacy NeoX smoke", function () {
  it("deploys core router plus auxiliary contracts", async function () {
    const [owner, treasury, user] = await ethers.getSigners();

    const osToken: OnlySwapToken = await new OnlySwapToken__factory(owner).deploy(
      ethers.parseEther("1000000"),
      treasury.address,
      owner.address
    );
    await osToken.waitForDeployment();

    const factory: UniswapV2Factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router: UniswapV2Router02 = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(),
      await osToken.getAddress()
    );
    await router.waitForDeployment();

    expect(await factory.feeToSetter()).to.equal(owner.address);
    expect(await router.factory()).to.equal(await factory.getAddress());

    const staking: OnlySwapStaking = await new OnlySwapStaking__factory(owner).deploy(
      await osToken.getAddress(),
      await osToken.getAddress(),
      owner.address
    );
    await staking.waitForDeployment();

    await osToken.initializeAllocation(await staking.getAddress());
    await osToken.connect(treasury).transfer(user.address, ethers.parseEther("1000"));
    await staking.startRewards(10n);

    await osToken.connect(user).approve(await staking.getAddress(), ethers.parseEther("100"));
    await staking.connect(user).deposit(ethers.parseEther("100"));
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);

    expect(await staking.totalStaked()).to.equal(ethers.parseEther("100"));
    expect(await staking.pendingReward(user.address)).to.be.gt(0n);

    const tokenDeployer: EvmTokenDeployer = await new EvmTokenDeployer__factory(owner).deploy();
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
});
