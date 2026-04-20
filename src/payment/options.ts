import {
  caip2ToLegacyNetworkIds,
  caip2ToCluster,
  lookupKnownSPLToken,
  type KnownSPLToken,
} from "@faremeter/info/solana";
import {
  caip2ToChainId,
  caip2ToLegacyName,
  lookupKnownAsset,
  type KnownAsset,
} from "@faremeter/info/evm";
import { normalizeNetworkId } from "@faremeter/info";
import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";
import {
  formatDisplayTokenAmount,
  printFormatted,
  type OutputFormat,
} from "../output/format.js";

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

export type PaymentOption = {
  asset: string;
  symbol: string | null;
  amount: string;
  decimals: number | null;
  formattedAmount: string;
  network: string;
  scheme: string;
};

type PaymentOptionView = {
  asset: string;
  address: string;
  amount: string;
  network: string;
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

function resolveAssetSymbol(network: string, asset: string): string | null {
  if (network.startsWith("solana:")) {
    return resolveSolanaAssetSymbol(network, asset);
  }

  if (network.startsWith("eip155:")) {
    return resolveEvmAssetSymbol(network, asset);
  }

  return null;
}

function getKnownAssetDecimals(network: string, asset: string): number | null {
  const symbol = resolveAssetSymbol(network, asset);
  if (symbol == null) {
    return null;
  }

  return 6;
}

function formatPaymentOptionNetwork(network: string): string {
  if (network.startsWith("solana:")) {
    return caip2ToLegacyNetworkIds(network)?.[0] ?? network;
  }

  if (network.startsWith("eip155:")) {
    return caip2ToLegacyName(network) ?? network;
  }

  return network;
}

export function getPaymentOptions(
  accepts: x402PaymentRequirementsV2[],
): PaymentOption[] {
  return accepts.map((requirement) => {
    const network = normalizeNetworkId(requirement.network);
    const symbol = resolveAssetSymbol(network, requirement.asset);
    const decimals =
      extractRequirementDecimals(requirement) ??
      getKnownAssetDecimals(network, requirement.asset);
    return {
      asset: requirement.asset,
      symbol,
      amount: requirement.amount,
      decimals,
      formattedAmount: formatDisplayTokenAmount({
        amount: requirement.amount,
        asset: symbol ?? requirement.asset,
        decimals,
      }),
      network,
      scheme: requirement.scheme,
    };
  });
}

export function printPaymentOptions(
  format: OutputFormat,
  options: PaymentOption[],
): void {
  const view = options.map(
    (option): PaymentOptionView => ({
      asset: option.symbol ?? "(unknown)",
      address: option.asset,
      amount: option.formattedAmount,
      network: formatPaymentOptionNetwork(option.network),
    }),
  );

  printFormatted(
    format,
    view,
    ["Asset", "Address", "Amount", "Network"],
    (option) => [option.asset, option.address, option.amount, option.network],
  );
}
