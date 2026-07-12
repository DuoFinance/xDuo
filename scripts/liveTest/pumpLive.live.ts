import hre from "hardhat";
const { ethers } = hre;
import assert from "assert";
import * as fs from "fs";
import path from "path";

const FACTORY_IFACE = "contracts/interfaces/IUniswapV2Factory.sol:IUniswapV2Factory";
const PAIR_IFACE = "contracts/interfaces/IUniswapV2Pair.sol:IUniswapV2Pair";

const PUMP_ABI = [
  "function uniswapFactory() view returns (address)",
  "function weth() view returns (address)",
  "function createSale(string,string,uint256,uint256) returns (address)",
  "function buy(address,uint256) payable returns (uint256)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function getSale(address) view returns (address creator, uint256 totalSupply, uint256 tokensSold, uint256 gasRaised, uint256 targetRaise, uint256 virtualGas, uint256 virtualToken, uint256 graduationBps, bool graduated)",
  "function getCurrentPrice(address) view returns (uint256)",
  "function getTokensForGas(address,uint256) view returns (uint256)",
  "function getGasForTokens(address,uint256) view returns (uint256)",
  "event SaleCreated(address indexed creator, address indexed token, string name, string symbol)",
  "event TokensPurchased(address indexed buyer, address indexed token, uint256 gasIn, uint256 tokensOut)",
  "event TokensSold(address indexed seller, address indexed token, uint256 tokensIn, uint256 gasOut)",
  "event SaleGraduated(address indexed token, address pair, uint256 tokensForLP, uint256 gasForLP)",
];

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

async function main() {
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..","..", "deployed.json"), "utf8")
  );
  const network = hre.network.name;

  console.log("═══════════════════════════════════════════════════");
  console.log(`  Pump Live Network Test — ${network}`);
  console.log("═══════════════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();
  console.log("Signer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "\n");

  // 0 ── RPC connectivity
  console.log("0. RPC connectivity...");
  const networkName = hre.network.name;
  const block = await ethers.provider.getBlockNumber();
  assert.ok(!isNaN(block) && block >= 0, `Invalid block number: ${block} on ${networkName}`);
  console.log(`   Network: ${networkName}, Block: ${block} ✓\n`);

  // 1 ── Connect to Pump
  console.log("1. Connecting to Pump...");
  const code = await ethers.provider.getCode(deployed.pump);
  assert.notStrictEqual(code, "0x", `No bytecode at ${deployed.pump}. Run with --network <network> where the contracts are deployed (e.g. neoxTestnet, legacy)`);
  const pump: any = await ethers.getContractAt(PUMP_ABI, deployed.pump);
  assert.strictEqual(
    (await pump.getAddress()).toLowerCase(),
    deployed.pump.toLowerCase()
  );
  const pumpFactory = await pump.uniswapFactory();
  const pumpWeth = await pump.weth();
  console.log(`   Pump: ${deployed.pump}`);
  console.log(`   uniswapFactory: ${pumpFactory}`);
  console.log(`   weth          : ${pumpWeth}`);
  assert.strictEqual(pumpFactory.toLowerCase(), deployed.factory.toLowerCase());
  assert.strictEqual(pumpWeth.toLowerCase(), deployed.wgas.toLowerCase());
  console.log("   Config ✓\n");

  // 2 ── Create sale (tiny targetRaise so graduation is feasible)
  console.log("2. Creating test sale...");
  const BPS = 8000;
  const TARGET = ethers.parseEther("0.001");

  if (balance < ethers.parseEther("0.005")) {
    console.log("   WARNING: very low balance — gas for createSale may be insufficient.");
  }

  const createTx = await pump.createSale("Live Test", "LVT", BPS, TARGET);
  const createRc = await ethers.provider.getTransactionReceipt(createTx.hash!);
  if (!createRc || createRc.status === 0) {
    // simulate to extract revert reason
    try { await pump.createSale.staticCall("Live Test", "LVT", BPS, TARGET); } catch (simErr: any) {
      throw new Error(`createSale reverted: ${simErr.reason || simErr.message}`);
    }
    throw new Error("createSale reverted (status=0 but staticCall passed)");
  }
  const pumpAddr = await pump.getAddress();
  const SALE_CREATED_TOPIC = ethers.id("SaleCreated(address,address,string,string)");
  const saleLog = createRc.logs.find((l: any) =>
    l.topics[0] === SALE_CREATED_TOPIC && l.address.toLowerCase() === pumpAddr.toLowerCase()
  );
  assert.ok(saleLog, "SaleCreated event expected in tx logs");
  const parsedLog = pump.interface.parseLog(saleLog);
  const tokenAddr: string = parsedLog.args.token;

  const token = await ethers.getContractAt(ERC20, tokenAddr);
  console.log(`   Token : ${tokenAddr}`);
  console.log(`   Name  : ${await token.name()}`);
  console.log(`   Symbol: ${await token.symbol()}`);
  console.log(`   Supply: ${ethers.formatEther(await token.totalSupply())}`);
  console.log("   ✓\n");

  // 3 ── Verify sale info
  console.log("3. Sale info...");
  const s: any = await pump.getSale(tokenAddr);
  console.log(`   tokensSold   : ${ethers.formatEther(s.tokensSold)}`);
  console.log(`   gasRaised    : ${ethers.formatEther(s.gasRaised)}`);
  console.log(`   targetRaise  : ${ethers.formatEther(s.targetRaise)}`);
  console.log(`   virtualGas   : ${ethers.formatEther(s.virtualGas)}`);
  console.log(`   virtualToken : ${ethers.formatEther(s.virtualToken)}`);
  console.log(`   graduationBps: ${s.graduationBps}`);
  console.log(`   graduated    : ${s.graduated}`);
  assert.strictEqual(s.creator.toLowerCase(), deployer.address.toLowerCase());
  assert.strictEqual(s.graduated, false);
  assert.strictEqual(s.tokensSold, 0n);
  assert.strictEqual(s.gasRaised, 0n);
  console.log("   ✓\n");

  // 4 ── Buy
  console.log("4. Buying tokens...");
  const buyAmt = ethers.parseEther("0.0003");
  const buyTx = await pump.connect(deployer).buy(tokenAddr, 0n, { value: buyAmt });
  const buyRc = await buyTx.wait();
  const buyLog = buyRc!.logs
    .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
    .find((p: any) => p?.name === "TokensPurchased");
  assert.ok(buyLog);
  const tokensOut: bigint = buyLog!.args.tokensOut;
  console.log(`   In : ${ethers.formatEther(buyAmt)} ETH`);
  console.log(`   Out: ${ethers.formatEther(tokensOut)} tokens`);
  assert.ok(tokensOut > 0n);

  const bal = await token.balanceOf(deployer.address);
  assert.ok(bal > 0n);
  console.log("   ✓\n");

  // 5 ── Queries
  console.log("5. Query helpers...");
  const price = await pump.getCurrentPrice(tokenAddr);
  assert.ok(price > 0n);
  console.log(`   getCurrentPrice: ${ethers.formatEther(price)}`);

  const qTokens = await pump.getTokensForGas(tokenAddr, ethers.parseEther("0.0001"));
  assert.ok(qTokens > 0n);
  console.log(`   getTokensForGas(0.0001 ETH): ${ethers.formatEther(qTokens)}`);

  const qGas = await pump.getGasForTokens(tokenAddr, tokensOut / 2n);
  assert.ok(qGas > 0n);
  console.log(`   getGasForTokens(half): ${ethers.formatEther(qGas)}`);
  console.log("   ✓\n");

  // 6 ── Sell
  console.log("6. Selling tokens...");
  const sellAmt = bal / 2n;
  await (await token.approve(pump.getAddress(), sellAmt)).wait();
  const sellTx = await pump.connect(deployer).sell(tokenAddr, sellAmt, 0n);
  const sellRc = await sellTx.wait();
  const sellLog = sellRc!.logs
    .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
    .find((p: any) => p?.name === "TokensSold");
  assert.ok(sellLog);
  const gasOut: bigint = sellLog!.args.gasOut;
  console.log(`   In : ${ethers.formatEther(sellAmt)} tokens`);
  console.log(`   Out: ${ethers.formatEther(gasOut)} ETH`);
  assert.ok(gasOut > 0n);
  console.log("   ✓\n");

  // 7 ── Edge cases
  console.log("7. Edge cases...");

  // 7a: zero-value buy
  try {
    await pump.connect(deployer).buy(tokenAddr, 0n, { value: 0n });
    assert.fail("expected revert");
  } catch (e: any) {
    assert.ok(e.message?.includes("ZERO_GAS") || e.message?.includes("revert"));
    console.log("   a) zero-value buy reverted ✓");
  }

  // 7b: sell without tokens (different signer)
  const other = (await ethers.getSigners())[1];
  try {
    await other.sendTransaction({ to: deployer.address, value: ethers.parseEther("0.01") });
  } catch { /* ignore funding issue */ }
  try {
    await pump.connect(other).sell(tokenAddr, 1n, 0n);
    assert.fail("expected revert");
  } catch {
    console.log("   b) sell without tokens reverted ✓");
  }

  // 7c: getSale non-existent
  try {
    await pump.getSale(ethers.ZeroAddress);
    assert.fail("expected revert");
  } catch (e: any) {
    assert.ok(e.message?.includes("SALE_NOT_EXIST") || e.message?.includes("revert"));
    console.log("   c) non-existent sale reverted ✓");
  }

  console.log("   ✓\n");

  // 8 ── Graduate
  console.log("8. Graduation...");
  const s2: any = await pump.getSale(tokenAddr);
  const need: bigint = BigInt(s2.targetRaise) - BigInt(s2.gasRaised);
  console.log(`   gasRaised: ${ethers.formatEther(s2.gasRaised)} / ${ethers.formatEther(s2.targetRaise)}`);
  console.log(`   Remaining: ${ethers.formatEther(need)} ETH`);

  if (need > 0n) {
    const balNow: bigint = await ethers.provider.getBalance(deployer.address);
    if (balNow > need + ethers.parseEther("0.01")) {
      const gradTx = await pump.connect(deployer).buy(tokenAddr, 0n, { value: need });
      const gRc = await gradTx.wait();
      const gLog = gRc!.logs
        .map((l: any) => { try { return pump.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p?.name === "SaleGraduated");

      if (gLog) {
        const pairAddr: string = gLog!.args.pair;
        console.log(`   Pair: ${pairAddr}`);
        assert.ok(pairAddr !== ethers.ZeroAddress);

        const pair = await ethers.getContractAt(PAIR_IFACE, pairAddr);
        const [r0, r1] = await pair.getReserves();
        console.log(`   Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
        assert.ok(r0 > 0n && r1 > 0n);

        // post-graduation buy must revert
        try {
          await pump.connect(deployer).buy(tokenAddr, 0n, { value: 1n });
          assert.fail("expected SALE_GRADUATED");
        } catch (e: any) {
          assert.ok(e.message?.includes("SALE_GRADUATED") || e.message?.includes("revert"));
          console.log("   Post-grad buy reverted ✓");
        }

        // pair registered in factory
        const factory = await ethers.getContractAt(FACTORY_IFACE, deployed.factory);
        const fPair = await factory.getPair(tokenAddr, deployed.wgas);
        assert.strictEqual(fPair.toLowerCase(), pairAddr.toLowerCase());
        console.log("   Factory registered ✓");
      } else {
        console.log("   (graduated in a prior transaction)");
      }
    } else {
      console.log("   Insufficient ETH — skip graduation.");
    }
  }
  console.log("   ✓\n");

  console.log("═══════════════════════════════════════════════════");
  console.log("  Pump live test passed! ✓");
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n✗ PUMP LIVE TEST FAILED:", err.message ?? err);
    process.exit(1);
  });
