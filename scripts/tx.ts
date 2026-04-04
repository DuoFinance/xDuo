import { ethers } from "hardhat";
import type { Provider } from "ethers";
import type { ChainConfig } from "../config/chains";

export type TxOverrides = {
  gasLimit: bigint;
  type?: 0 | 2;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

function parseGwei(value?: string): bigint | undefined {
  if (!value) return undefined;
  return ethers.parseUnits(value, "gwei");
}

export async function buildTxOverrides(
  provider: Provider,
  chain: ChainConfig,
  gasLimit: bigint
): Promise<TxOverrides> {
  const feeData = await provider.getFeeData();
  const gasPrice = parseGwei(chain.gasPriceGwei) ?? feeData.gasPrice ?? undefined;
  const maxFeePerGas = parseGwei(chain.maxFeePerGasGwei) ?? feeData.maxFeePerGas ?? undefined;
  const maxPriorityFeePerGas =
    parseGwei(chain.maxPriorityFeePerGasGwei) ?? feeData.maxPriorityFeePerGas ?? undefined;

  const overrides: TxOverrides = { gasLimit };

  if (chain.txType === "legacy") {
    if (!gasPrice) {
      throw new Error("Legacy tx mode requires provider gasPrice or *_GAS_PRICE_GWEI.");
    }
    overrides.type = 0;
    overrides.gasPrice = gasPrice;
    return overrides;
  }

  if (chain.txType === "eip1559") {
    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      throw new Error(
        "EIP-1559 tx mode requires provider support or *_MAX_FEE_PER_GAS_GWEI and *_MAX_PRIORITY_FEE_PER_GAS_GWEI."
      );
    }
    overrides.type = 2;
    overrides.maxFeePerGas = maxFeePerGas;
    overrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
    return overrides;
  }

  if (maxFeePerGas && maxPriorityFeePerGas) {
    overrides.type = 2;
    overrides.maxFeePerGas = maxFeePerGas;
    overrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
    return overrides;
  }

  if (gasPrice) {
    overrides.type = 0;
    overrides.gasPrice = gasPrice;
    return overrides;
  }

  return overrides;
}
