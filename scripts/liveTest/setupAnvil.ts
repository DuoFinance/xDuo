import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import path from "path";

const DEPLOYED_PATH = path.join(__dirname, "..", "..", "deployed.json");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "\n");

  // 1. Use fork's existing WGAS contract at the mainnet address
  const originalDeployed = JSON.parse(fs.readFileSync(DEPLOYED_PATH, "utf8"));
  const wgasAddr = originalDeployed.wgas;
  const wgasCode = await ethers.provider.getCode(wgasAddr);
  console.log("1. Using WGAS from fork:", wgasAddr, "(code:", wgasCode !== "0x" ? "OK" : "MISSING)", ")");

  // 2. Deploy Factory
  console.log("2. Deploying UniswapV2Factory...");
  const Factory = await ethers.getContractFactory("contracts/UniswapV2Factory.sol:UniswapV2Factory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("   Factory:", factoryAddr);

  // 3. Deploy Router
  console.log("3. Deploying UniswapV2Router02...");
  const Router = await ethers.getContractFactory("contracts/UniswapV2Router02.sol:UniswapV2Router02");
  const router = await Router.deploy(factoryAddr, wgasAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("   Router:", routerAddr);

  // 4. Deploy Pump (DuoLaunch)
  console.log("4. Deploying DuoLaunch...");
  const Pump = await ethers.getContractFactory("contracts/duoLaunch/DuoLaunch.sol:DuoLaunch");
  const pump = await Pump.deploy(factoryAddr, wgasAddr);
  await pump.waitForDeployment();
  const pumpAddr = await pump.getAddress();
  console.log("   Pump:", pumpAddr);

  // 5. Save deployed.json
  const deployed = {
    factory: factoryAddr,
    router: routerAddr,
    pump: pumpAddr,
    wgas: wgasAddr,
    staking: "",
  };
  fs.writeFileSync(DEPLOYED_PATH, JSON.stringify(deployed, null, 2) + "\n");
  console.log("\n5. Saved deployed.json");
  console.log(JSON.stringify(deployed, null, 2));
  console.log("\n✅ Anvil setup complete!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Setup failed:", err.message ?? err);
    process.exit(1);
  });
