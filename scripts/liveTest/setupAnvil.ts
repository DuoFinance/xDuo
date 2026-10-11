import hre from "hardhat";
const { ethers } = hre;
import * as fs from "fs";
import { ANVIL_DEPLOYED_PATH, DEPLOYED_PATH } from "./addresses";

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function pickAddress(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      candidate.trim() !== "" &&
      ethers.isAddress(candidate.trim())
    ) {
      return candidate.trim();
    }
  }
  return null;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "\n");

  // 1. Resolve WGAS: previous anvil run -> frontend deployed.json -> env.
  //    Anvil forks NeoX mainnet, so the mainnet WGAS address is the one that
  //    exists on-chain. deployed.json itself never carries a WGAS entry.
  const previousAnvil = readJson(ANVIL_DEPLOYED_PATH);
  const frontendDeployed = readJson(DEPLOYED_PATH);

  const wgasAddr = pickAddress(
    previousAnvil.WGAS,
    frontendDeployed.WGAS,
    frontendDeployed.WGAS_ADDRESS,
    process.env.NEOX_MAINNET_WGAS_ADDRESS,
    process.env.LEGACY_WGAS_ADDRESS,
  );
  if (!wgasAddr) {
    throw new Error(
      "WGAS address not found: set NEOX_MAINNET_WGAS_ADDRESS in .env",
    );
  }

  const wgasCode = await ethers.provider.getCode(wgasAddr);
  if (wgasCode === "0x") {
    throw new Error(
      `No code at WGAS ${wgasAddr} on this fork — check NEOX_MAINNET_WGAS_ADDRESS in .env`,
    );
  }
  console.log("1. Using WGAS from fork:", wgasAddr, "(code: OK)");

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

  // 5. Save local-only addresses (same uppercase schema as deployed.json).
  //    deployed.json stays untouched: it is the frontend/deploy-scripts file
  //    and must not absorb Anvil addresses.
  const saved = {
    FACTORY: factoryAddr,
    ROUTER: routerAddr,
    BONDING: pumpAddr,
    WGAS: wgasAddr,
    STAKING: typeof previousAnvil.STAKING === "string" ? previousAnvil.STAKING : "",
  };
  fs.writeFileSync(ANVIL_DEPLOYED_PATH, JSON.stringify(saved, null, 2) + "\n");
  console.log(`\n5. Saved ${ANVIL_DEPLOYED_PATH}`);
  console.log(JSON.stringify(saved, null, 2));
  console.log("\n✅ Anvil setup complete!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Setup failed:", err.message ?? err);
    process.exit(1);
  });
