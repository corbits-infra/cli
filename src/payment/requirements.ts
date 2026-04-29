import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import { normalizeNetworkId } from "@faremeter/info";
import {
  caip2ToChainId,
  caip2ToLegacyName,
  lookupKnownAsset,
  type KnownAsset,
} from "@faremeter/info/evm";
import {
  caip2ToLegacyNetworkIds,
  caip2ToCluster,
  lookupKnownSPLToken,
  type KnownSPLToken,
} from "@faremeter/info/solana";
import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";

import { ConfigError } from "../config/index.js";
import {
  formatPaymentNetworkDisplay,
  getPaymentNetworkContext,
  type PaymentNetwork,
} from "../config/schema.js";
import {
  getEvmChainInfoForNetwork,
  getSolanaClusterForNetwork,
} from "./networks.js";

const KNOWN_SOLANA_TOKENS = [
  "USDC",
  "PYUSD",
  "USDT",
  "USDG",
  "USD1",
  "USX",
  "CASH",
  "EURC",
  "JupUSD",
  "USDS",
  "USDtb",
  "USDu",
  "USDGO",
  "FDUSD",
] as const satisfies readonly KnownSPLToken[];

const KNOWN_EVM_ASSETS = ["USDC"] as const satisfies readonly KnownAsset[];

export type PaymentRequirementDetails = {
  requirement: x402PaymentRequirementsV2;
  asset: string;
  symbol: string | null;
  amount: string;
  decimals: number | null;
  network: string;
  scheme: string;
};

export type KnownPaymentAssetDetails = {
  asset: string;
  symbol: string;
  decimals: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function extractRequirementDecimals(
  requirement: x402PaymentRequirementsV2,
): number | null {
  if (!isRecord(requirement.extra)) {
    return null;
  }

  const { decimals } = requirement.extra;
  return typeof decimals === "number" ? decimals : null;
}

function resolveSolanaAssetSymbol(
  network: string,
  asset: string,
): string | null {
  const cluster = caip2ToCluster(network);
  if (cluster == null) {
    return null;
  }

  for (const symbol of KNOWN_SOLANA_TOKENS) {
    const token = lookupKnownSPLToken(cluster, symbol);
    if (token?.address === asset) {
      return symbol;
    }
  }

  return null;
}

function resolveEvmAssetSymbol(network: string, asset: string): string | null {
  const chainId = caip2ToChainId(network);
  if (chainId == null) {
    return null;
  }

  for (const symbol of KNOWN_EVM_ASSETS) {
    const knownAsset = lookupKnownAsset(chainId, symbol);
    if (knownAsset?.address.toLowerCase() === asset.toLowerCase()) {
      return symbol;
    }
  }

  return null;
}

function findSolanaSymbolByInput(input: string): KnownSPLToken | null {
  const normalized = input.toUpperCase();
  for (const symbol of KNOWN_SOLANA_TOKENS) {
    if (symbol.toUpperCase() === normalized) {
      return symbol;
    }
  }
  return null;
}

function findEvmSymbolByInput(input: string): KnownAsset | null {
  const normalized = input.toUpperCase();
  for (const symbol of KNOWN_EVM_ASSETS) {
    if (symbol.toUpperCase() === normalized) {
      return symbol;
    }
  }
  return null;
}

function resolveKnownSolanaAsset(
  network: PaymentNetwork,
  input: string,
): KnownPaymentAssetDetails {
  const cluster = getSolanaClusterForNetwork(network);
  try {
    new PublicKey(input);
    for (const symbol of KNOWN_SOLANA_TOKENS) {
      const token = lookupKnownSPLToken(cluster, symbol);
      if (token?.address === input) {
        return { asset: token.address, symbol, decimals: 6 };
      }
    }
    throw new ConfigError(
      `Asset address ${input} is not registered on ${formatPaymentNetworkDisplay(network)}`,
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
  }

  const symbol = findSolanaSymbolByInput(input);
  if (symbol == null) {
    throw new ConfigError(
      `Unknown asset symbol ${input} for ${formatPaymentNetworkDisplay(network)}`,
    );
  }
  const token = lookupKnownSPLToken(cluster, symbol);
  if (token == null) {
    throw new ConfigError(
      `Asset symbol ${symbol} is not registered on ${formatPaymentNetworkDisplay(network)}`,
    );
  }
  return { asset: token.address, symbol, decimals: 6 };
}

function resolveKnownEvmAsset(
  network: PaymentNetwork,
  input: string,
): KnownPaymentAssetDetails {
  const chainInfo = getEvmChainInfoForNetwork(network);
  if (isAddress(input, { strict: false })) {
    for (const symbol of KNOWN_EVM_ASSETS) {
      const asset = lookupKnownAsset(chainInfo.id, symbol);
      if (asset?.address.toLowerCase() === input.toLowerCase()) {
        return { asset: asset.address, symbol, decimals: 6 };
      }
    }
    throw new ConfigError(
      `Asset address ${input} is not registered on ${formatPaymentNetworkDisplay(network)}`,
    );
  }

  const symbol = findEvmSymbolByInput(input);
  if (symbol == null) {
    throw new ConfigError(
      `Unknown asset symbol ${input} for ${formatPaymentNetworkDisplay(network)}`,
    );
  }
  const asset = lookupKnownAsset(chainInfo.id, symbol);
  if (asset == null) {
    throw new ConfigError(
      `Asset symbol ${symbol} is not registered on ${formatPaymentNetworkDisplay(network)}`,
    );
  }
  return { asset: asset.address, symbol, decimals: 6 };
}

export function resolvePaymentAssetSymbol(
  network: string,
  asset: string,
): string | null {
  if (network.startsWith("solana:")) {
    return resolveSolanaAssetSymbol(network, asset);
  }

  if (network.startsWith("eip155:")) {
    return resolveEvmAssetSymbol(network, asset);
  }

  return null;
}

export function getKnownPaymentAssetDecimals(
  network: string,
  asset: string,
): number | null {
  return resolvePaymentAssetSymbol(network, asset) == null ? null : 6;
}

export function resolveKnownPaymentAsset(
  network: PaymentNetwork,
  input: string,
): KnownPaymentAssetDetails {
  return getPaymentNetworkContext(network).family === "solana"
    ? resolveKnownSolanaAsset(network, input)
    : resolveKnownEvmAsset(network, input);
}

export function formatPaymentOptionNetwork(network: string): string {
  if (network.startsWith("solana:")) {
    return caip2ToLegacyNetworkIds(network)?.[0] ?? network;
  }

  if (network.startsWith("eip155:")) {
    return caip2ToLegacyName(network) ?? network;
  }

  return network;
}

export function getPaymentRequirementDetails(
  accepts: x402PaymentRequirementsV2[],
): PaymentRequirementDetails[] {
  return accepts.map((requirement) => {
    const network = normalizeNetworkId(requirement.network);
    const symbol = resolvePaymentAssetSymbol(network, requirement.asset);
    const decimals =
      extractRequirementDecimals(requirement) ??
      getKnownPaymentAssetDecimals(network, requirement.asset);

    return {
      requirement: { ...requirement, network },
      asset: requirement.asset,
      symbol,
      amount: requirement.amount,
      decimals,
      network,
      scheme: requirement.scheme,
    };
  });
}
