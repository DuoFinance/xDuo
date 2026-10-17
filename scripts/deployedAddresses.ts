import path from "path";

const ROOT = path.resolve(__dirname, "..");

export function deployedPathForNetwork(networkName: string): string {
  switch (networkName) {
    case "anvil":
      return path.join(ROOT, "deployed.anvil.json");
    case "neoxTestnet":
      return path.join(ROOT, "deployed.testnet.json");
    case "neoxMainnet":
      return path.join(ROOT, "deployed.mainnet.json");
    default:
      return path.join(ROOT, "deployed.json");
  }
}
