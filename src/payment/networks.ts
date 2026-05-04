import { evm, normalizeNetworkId, solana } from "@faremeter/info";
import { ConfigError } from "../config/index.js";
import { getPaymentNetworkContext } from "../config/schema.js";
import type { PaymentNetwork, ResolvedConfig } from "../config/index.js";

export type EvmChainInfo = {
  id: number;
  name: string;
  owsChain: string;
};

export function getSolanaClusterForNetwork(
  network: PaymentNetwork,
): "mainnet-beta" | "devnet" {
  if (getPaymentNetworkContext(network).family !== "solana") {
    throw new ConfigError(`Solana payments do not support network ${network}`);
  }
  let resolved;
  try {
    resolved = solana.lookupX402Network(network);
  } catch {
    throw new ConfigError(`Solana payments do not support network ${network}`);
  }
  if (resolved.name !== "mainnet-beta" && resolved.name !== "devnet") {
    throw new ConfigError(`Solana payments do not support network ${network}`);
  }
  return resolved.name;
}

export function getEvmChainInfoForNetwork(
  network: PaymentNetwork,
): EvmChainInfo {
  if (getPaymentNetworkContext(network).family !== "evm") {
    throw new ConfigError(`EVM payments do not support network ${network}`);
  }
  const caip2Network = normalizeNetworkId(network);
  if (!evm.isKnownCAIP2Network(caip2Network)) {
    throw new ConfigError(`EVM payments do not support network ${network}`);
  }
  let resolved;
  try {
    resolved = evm.lookupKnownCAIP2Network(caip2Network);
  } catch {
    throw new ConfigError(`EVM payments do not support network ${network}`);
  }

  return {
    id: resolved.chainId,
    name: resolved.legacyName === "base" ? "Base" : "Base Sepolia",
    owsChain: resolved.legacyName,
  };
}

export function getSolanaCluster(
  config: ResolvedConfig,
): "mainnet-beta" | "devnet" {
  return getSolanaClusterForNetwork(config.payment.network);
}

export function getEvmChainInfo(config: ResolvedConfig): EvmChainInfo {
  return getEvmChainInfoForNetwork(config.payment.network);
}
