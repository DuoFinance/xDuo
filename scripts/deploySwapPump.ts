import hre, { ethers } from "hardhat";

const FACTORY_FQN = "contracts/UniswapV2Factory.sol:UniswapV2Factory";
const ROUTER_FQN = "contracts/UniswapV2Router02.sol:UniswapV2Router02";
const WGAS_ADDRESS = "0xdE41591ED1f8ED1484aC2CD8ca0876428de60EfF";

// Anvil default account #0 (pre-funded with 10000 ETH on anvil fork)
const ANVIL_DEFAULT_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function main() {
  // Use anvil's default funded account directly
  const deployer = new ethers.Wallet(ANVIL_DEFAULT_PK, ethers.provider);

  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("Deployer ETH:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));
  console.log("WGAS:", WGAS_ADDRESS);

  // 1. Deploy Factory
  const factoryOverrides: any = { gasLimit: 6_000_000n };
  const Factory = await ethers.getContractFactory(FACTORY_FQN);
  const factory = await Factory.deploy(deployer.address, factoryOverrides);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory:", factoryAddress);

  // 2. Deploy Router (with WGAS)
  const routerOverrides: any = { gasLimit: 8_000_000n };
  const Router = await ethers.getContractFactory(ROUTER_FQN);
  const router = await Router.deploy(factoryAddress, WGAS_ADDRESS, routerOverrides);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router:", routerAddress);

  // 3. Verify router config
  const routerWgas = await router.WETH();
  console.log("Router WGAS:", routerWgas);
  if (routerWgas.toLowerCase() !== WGAS_ADDRESS.toLowerCase()) {
    throw new Error("WGAS mismatch!");
  }

  // 4. Deploy Pump
  const pumpOverrides: any = { gasLimit: 3_000_000n };
  const Pump = await ethers.getContractFactory("Pump");
  const pump = await Pump.deploy(routerAddress, pumpOverrides);
  await pump.waitForDeployment();
  const pumpAddress = await pump.getAddress();
  console.log("Pump:", pumpAddress);

  // Save addresses
  const fs = await import("fs");
  const deployed = {
    factory: factoryAddress,
    router: routerAddress,
    pump: pumpAddress,
    wgas: WGAS_ADDRESS,
    deployer: deployer.address,
  };
  fs.writeFileSync("deployed.json", JSON.stringify(deployed, null, 2));
  console.log("Saved to deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
