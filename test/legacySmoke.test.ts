import { expect } from "chai";
import { ethers } from "hardhat";
import type {
  DuoTokenDeployer,
  DuoSwapStaking,
  DuoSwapStakingFactory,
  DuoToken,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02,
  DuoBondingCurve,
  DuoLaunch,
  TokenTemplate
} from "../typechain-types";
import {
  DuoTokenDeployer__factory,
  DuoSwapStaking__factory,
  DuoSwapStakingFactory__factory,
  DuoToken__factory,
  UniswapV2Factory__factory,
  UniswapV2Pair__factory,
  UniswapV2Router02__factory,
  DuoBondingCurve__factory,
  DuoLaunch__factory,
  TokenTemplate__factory
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

  it("deploys bonding curve and executes buy/sell/graduate", async function () {
    const [owner, user1, user2] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();

    const factory: UniswapV2Factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router: UniswapV2Router02 = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(),
      await weth.getAddress()
    );
    await router.waitForDeployment();

    const CurveFactory = await ethers.getContractFactory("DuoBondingCurveFactory");
    const curveFactory = await CurveFactory.deploy();
    await curveFactory.waitForDeployment();

    // Deploy a curve token
    // gradient = 1e15, targetReserve = 5 ETH
    const gradient = ethers.parseEther("0.001");   // 0.001 ETH slope
    const targetReserve = ethers.parseEther("5");  // 5 ETH target
    const tx = await curveFactory.deployCurve(
      "Fair Token",
      "FAIR",
      gradient,
      targetReserve,
      await router.getAddress(),
      await factory.getAddress()
    );
    const receipt = await tx.wait();

    const deployedLog = receipt!.logs
      .map((log: any) => {
        try { return curveFactory.interface.parseLog(log); }
        catch { return null; }
      })
      .find((parsed: any) => parsed?.name === "CurveDeployed");

    const curveAddr = deployedLog!.args.token as string;
    const curve: DuoBondingCurve = DuoBondingCurve__factory.connect(curveAddr, owner);

    expect(await curveFactory.getCurveCount()).to.equal(1n);
    expect(await curve.name()).to.equal("Fair Token");
    expect(await curve.symbol()).to.equal("FAIR");
    expect(await curve.gradient()).to.equal(gradient);
    expect(await curve.targetReserve()).to.equal(targetReserve);
    expect(await curve.graduated()).to.equal(false);

    // User1 buys 1 ETH worth
    await curve.connect(user1).buy({ value: ethers.parseEther("1") });
    const bal1 = await curve.balanceOf(user1.address);
    expect(bal1).to.be.gt(0n);
    expect(await curve.curveReserve()).to.equal(ethers.parseEther("1"));

    // User2 buys 2 ETH worth
    await curve.connect(user2).buy({ value: ethers.parseEther("2") });
    const bal2 = await curve.balanceOf(user2.address);
    expect(bal2).to.be.gt(0n);
    expect(await curve.curveReserve()).to.equal(ethers.parseEther("3"));

    // Price should be > 0
    const price = await curve.getPrice();
    expect(price).to.be.gt(0n);

    // User1 sells half their tokens
    const sellAmount = bal1 / 2n;
    const expectedReturn = await curve.getSellReturn(sellAmount);
    expect(expectedReturn).to.be.gt(0n);

    await curve.connect(user1).sell(sellAmount);
    expect(await curve.balanceOf(user1.address)).to.equal(bal1 - sellAmount);
    expect(await curve.curveReserve()).to.be.lt(ethers.parseEther("3"));

    // Buy remaining to hit target (reach 5 ETH reserve)
    const remaining = ethers.parseEther("5") - await curve.curveReserve();
    await curve.connect(owner).buy({ value: remaining });
    expect(await curve.graduated()).to.equal(true);
    expect(await curve.pair()).to.not.equal(ethers.ZeroAddress);
    expect(await curve.curveReserve()).to.equal(ethers.parseEther("5"));

    // After graduation, buy should revert
    await expect(
      curve.connect(owner).buy({ value: ethers.parseEther("1") })
    ).to.be.revertedWith("GRADUATED");

    // After graduation, sell should revert
    await expect(
      curve.connect(user2).sell(1n)
    ).to.be.revertedWith("GRADUATED");
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

  it("DuoLaunch: full buy/sell/graduate lifecycle with price continuity", async function () {
    const [owner, user1, user2] = await ethers.getSigners();

    // 1. Deploy Uniswap V2 infrastructure
    const WETH = await ethers.getContractFactory("WETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();

    const factory: UniswapV2Factory = await new UniswapV2Factory__factory(owner).deploy(owner.address);
    await factory.waitForDeployment();

    const router: UniswapV2Router02 = await new UniswapV2Router02__factory(owner).deploy(
      await factory.getAddress(),
      await weth.getAddress()
    );
    await router.waitForDeployment();

    // 2. Deploy DuoLaunch
    const duoLaunch: DuoLaunch = await new DuoLaunch__factory(owner).deploy(await factory.getAddress(), await weth.getAddress());
    await duoLaunch.waitForDeployment();

    // 3. Create sale with P = 80%
    const graduationBps = 8000;
    const createTx = await duoLaunch.createSale("DuoLaunch Token", "PUMP", graduationBps, ethers.parseEther("1000"));
    const createReceipt = await createTx.wait();
    const createLog = createReceipt!.logs
      .map((log: any) => { try { return duoLaunch.interface.parseLog(log); } catch { return null; } })
      .find((parsed: any) => parsed?.name === "SaleCreated");
    const tokenAddr = createLog!.args.token as string;

    const token: TokenTemplate = TokenTemplate__factory.connect(tokenAddr, owner);

    // 4. Verify sale info
    const sale = await duoLaunch.getSale(tokenAddr);
    expect(sale.creator).to.equal(owner.address);
    // totalSupply is a fixed constant (1B), no longer in struct
    expect(sale.graduated).to.equal(false);

    expect(await token.name()).to.equal("DuoLaunch Token");
    expect(await token.symbol()).to.equal("PUMP");
    expect(await token.balanceOf(await duoLaunch.getAddress())).to.equal(ethers.parseEther("1000000000"));

    // 5. Buy: user1 sends 2 ETH
    const buy1 = await duoLaunch.connect(user1).buy(tokenAddr, 0n, { value: ethers.parseEther("2") });
    const buy1Receipt = await buy1.wait();
    const buy1Log = buy1Receipt!.logs
      .map((log: any) => { try { return duoLaunch.interface.parseLog(log); } catch { return null; } })
      .find((parsed: any) => parsed?.name === "TokensPurchased");
    const tokens1 = buy1Log!.args.tokensOut as bigint;
    expect(tokens1).to.be.gt(0n);
    expect(await token.balanceOf(user1.address)).to.equal(tokens1);

    const saleAfterBuy1 = await duoLaunch.getSale(tokenAddr);
    expect(saleAfterBuy1.GASRaised).to.equal(ethers.parseEther("2"));

    // 6. Query helper functions
    const price1 = await duoLaunch.getCurrentPrice(tokenAddr);
    expect(price1).to.be.gt(0n);

    const tokensForGAS = await duoLaunch.getTokensForGAS(tokenAddr, ethers.parseEther("1"));
    expect(tokensForGAS).to.be.gt(0n);

    // 7. Sell: user1 sells 25% of their tokens
    const sellAmount = tokens1 / 4n;
    await token.connect(user1).approve(await duoLaunch.getAddress(), sellAmount);

    const sellTx = await duoLaunch.connect(user1).sell(tokenAddr, sellAmount, 0n);
    const sellReceipt = await sellTx.wait();
    const sellLog = sellReceipt!.logs
      .map((log: any) => { try { return duoLaunch.interface.parseLog(log); } catch { return null; } })
      .find((parsed: any) => parsed?.name === "TokensSold");
    const GASOut = sellLog!.args.GASOut as bigint;
    expect(GASOut).to.be.gt(0n);

    expect(await token.balanceOf(user1.address)).to.equal(tokens1 - sellAmount);

    const saleAfterSell = await duoLaunch.getSale(tokenAddr);
    expect(saleAfterSell.tokensSold).to.equal(tokens1 - sellAmount);
    expect(saleAfterSell.GASRaised).to.equal(ethers.parseEther("2") - GASOut);

    // 8. Owner buys remaining to trigger graduation (over-send to test refund)
    const saleBeforeGrad = await duoLaunch.getSale(tokenAddr);
    const remainingTarget = saleBeforeGrad.targetRaise - saleBeforeGrad.GASRaised;
    const ownerEthBefore = await ethers.provider.getBalance(owner.address);
    // Send remainingTarget + 1 ETH extra to test refund
    const buyGrad = await duoLaunch.connect(owner).buy(tokenAddr, 0n, { value: remainingTarget + ethers.parseEther("1") });
    const buyGradReceipt = await buyGrad.wait();
    const buyGradLog = buyGradReceipt!.logs
      .map((log: any) => { try { return duoLaunch.interface.parseLog(log); } catch { return null; } })
      .find((parsed: any) => parsed?.name === "TokensPurchased");

    // Check owner got a refund (net ETH spent < remainingTarget + 1 ETH)
    const ownerEthAfter = await ethers.provider.getBalance(owner.address);
    const ownerEthSpent = ownerEthBefore - ownerEthAfter - buyGradReceipt!.gasUsed * buyGradReceipt!.gasPrice;
    expect(ownerEthSpent).to.be.lt(remainingTarget + ethers.parseEther("1"));

    // 9. Verify graduation
    const saleGrad = await duoLaunch.getSale(tokenAddr);
    expect(saleGrad.graduated).to.equal(true);

    // Verify SaleGraduated event is emitted
    const gradLog = buyGradReceipt!.logs
      .map((log: any) => { try { return duoLaunch.interface.parseLog(log); } catch { return null; } })
      .find((parsed: any) => parsed?.name === "SaleGraduated");
    expect(gradLog).to.not.be.undefined;
    const pairAddr = gradLog!.args.pair as string;
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);
    expect(gradLog!.args.tokensForLP).to.be.gt(0n);
    expect(gradLog!.args.GASForLP).to.equal(saleGrad.GASRaised);

    // 10. Verify LP tokens burned (sent to address(0))
    const pair: UniswapV2Pair = UniswapV2Pair__factory.connect(pairAddr, owner);
    const lpBalance = await pair.balanceOf(await duoLaunch.getAddress());
    expect(lpBalance).to.equal(0n); // LP minted to address(0), not to duoLaunch

    // 11. Price continuity: BC closing price ≈ Uniswap opening price
    // BC price  = (vGas + gasRaised) / (vToken - tokensSold)
    // Uniswap   = gasRaised / (totalSupply - tokensSold)
    const tokensForLP = ethers.parseEther("1000000000") - saleGrad.tokensSold;
    const bcGASReserve = saleGrad.virtualGAS + saleGrad.GASRaised;
    const bcTokenReserve = saleGrad.virtualToken - saleGrad.tokensSold;
    // Cross-multiply: (vGas+gasRaised) * (totalSupply-tokensSold) ≈ gasRaised * (vToken-tokensSold)
    const lhs = bcGASReserve * tokensForLP;
    const rhs = saleGrad.GASRaised * bcTokenReserve;
    const priceDiff = lhs > rhs ? lhs - rhs : rhs - lhs;
    // Relative error should be negligible (< 0.0001%)
    expect(priceDiff * 1000000n).to.be.lt(lhs + rhs);

    // 12. Post-graduation operations revert
    await expect(
      duoLaunch.connect(user2).buy(tokenAddr, 0n, { value: ethers.parseEther("1") })
    ).to.be.revertedWith("SALE_GRADUATED");

    await expect(
      duoLaunch.connect(user2).sell(tokenAddr, 1n, 0n)
    ).to.be.revertedWith("SALE_GRADUATED");
  });
});
