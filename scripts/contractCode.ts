import { isAddress, type Provider } from "ethers";

export async function requireContractCode(
  provider: Provider,
  address: string,
  label: string,
): Promise<void> {
  if (!isAddress(address)) {
    throw new Error(`Invalid ${label} address: ${address}`);
  }
  if ((await provider.getCode(address)) === "0x") {
    throw new Error(`No contract code found for ${label} at ${address}.`);
  }
}
