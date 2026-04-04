import { expect } from "chai";
import { ethers } from "hardhat";

describe("Uni2 legacy NeoX smoke", function () {
  it("deploys core router plus auxiliary contracts", async function () {
    const [owner, treasury, user] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("OnlySwapToken");
    const osToken = await Token.deploy(ethers.parseEther("1000000"), treasury.address, owner.address);
    await osToken.waitForDeployment();

    const Factory = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
    const factory = await Factory.deploy(owner.address);
    await factory.waitForDeployment();

    const Router = await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02");
    const router = await Router.deploy(await factory.getAddress(), await osToken.getAddress());
    await router.waitForDeployment();

    expect(await factory.feeToSetter()).to.equal(owner.address);
    expect(await router.factory()).to.equal(await factory.getAddress());

    const Staking = await ethers.getContractFactory("OnlySwapStaking");
    const staking = await Staking.deploy(await osToken.getAddress(), await osToken.getAddress(), owner.address);
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

    const TokenDeployer = await ethers.getContractFactory("EvmTokenDeployer");
    const tokenDeployer = await TokenDeployer.deploy();
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
