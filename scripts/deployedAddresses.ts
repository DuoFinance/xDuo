import path from "path";

/**
 * Deployment-record directory.
 *
 * `X_DEPLOYED_DIR` is a test/CI override so sync tests never write the real
 * deployed.*.json files at the repo root. Read at call time so a test can set
 * the env var after importing this module.
 */
function rootDir(): string {
  const override = process.env.X_DEPLOYED_DIR?.trim();
  return override ? path.resolve(override) : path.resolve(__dirname, "..");
}

export function deployedPathForNetwork(networkName: string): string {
  const root = rootDir();
  switch (networkName) {
    case "anvil":
      return path.join(root, "deployed.anvil.json");
    case "neoxTestnet":
      return path.join(root, "deployed.testnet.json");
    case "neoxMainnet":
      return path.join(root, "deployed.mainnet.json");
    default:
      return path.join(root, "deployed.json");
  }
}
