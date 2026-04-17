import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, isAddress, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { erc20 } from "@faremeter/payment-evm";
import { lookupX402Network } from "@faremeter/info/evm";
import { clusterToCAIP2, lookupKnownSPLToken } from "@faremeter/info/solana";
import { lookupKnownAsset } from "@faremeter/info/evm";
import { ConfigError } from "../config/index.js";
import type { PaymentNetwork, ResolvedConfig } from "../config/index.js";
import {
  formatPaymentNetworkDisplay,
  getPaymentNetworkContext,
  getPaymentNetworkDefaults,
} from "../config/schema.js";
import { formatTokenAmount } from "../output/format.js";
import {
  getEvmChainInfoForNetwork,
  getSolanaClusterForNetwork,
} from "./networks.js";
import { extractPaymentRequiredResponse } from "./signer.js";
import type { WrappedRunResult } from "../commands/call-wrapper.js";

const USDC_DECIMALS = 6;

export type BalanceLookupTarget = {
  network: PaymentNetwork;
  address: string;
  rpcUrl: string;
};

export type BalanceRecord = {
  address: string;
  network: string;
  asset: "USDC";
  amount: string;
};

type BalanceResolution = {
  record: BalanceRecord;
  rawAmount: bigint;
};

export type BalanceDeps = {
  getSolanaTokenBalance: (
    rpcUrl: string,
    mint: string,
    owner: string,
  ) => Promise<bigint>;
  getEvmPublicClient: (rpcUrl: string, chainId: number) => PublicClient;
  lookupKnownSPLToken: typeof lookupKnownSPLToken;
  lookupKnownAsset: typeof lookupKnownAsset;
};

export type PreflightBalanceDeps = BalanceDeps & {
  parseRequirements: (
    response: Response,
    url: string,
  ) => Promise<{ accepts: { network: string; amount: string }[] }>;
};

async function resolveSolanaBalance(
  target: BalanceLookupTarget,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const cluster = getSolanaClusterForNetwork(target.network);
  const tokenInfo = deps.lookupKnownSPLToken(cluster, "USDC");
  if (tokenInfo == null) {
    throw new ConfigError(`No known USDC mint for Solana cluster ${cluster}`);
  }
  const rawAmount = await deps.getSolanaTokenBalance(
    target.rpcUrl,
    tokenInfo.address,
    target.address,
  );
  return {
    record: {
      address: target.address,
      network: formatPaymentNetworkDisplay(target.network),
      asset: "USDC",
      amount: formatTokenAmount(String(rawAmount), USDC_DECIMALS),
    },
    rawAmount,
  };
}

async function resolveEvmBalance(
  target: BalanceLookupTarget,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const chainInfo = getEvmChainInfoForNetwork(target.network);
  const assetInfo = deps.lookupKnownAsset(chainInfo.id, "USDC");
  if (assetInfo == null) {
    throw new ConfigError(
      `No known USDC asset for EVM network ${target.network}`,
    );
  }
  const client = deps.getEvmPublicClient(target.rpcUrl, chainInfo.id);
  const result = await erc20.getTokenBalance({
    account: target.address as `0x${string}`,
    asset: assetInfo.address,
    client,
  });
  return {
    record: {
      address: target.address,
      network: formatPaymentNetworkDisplay(target.network),
      asset: "USDC",
      amount: formatTokenAmount(String(result.amount), result.decimals),
    },
    rawAmount: result.amount,
  };
}

function resolveByFamily(
  target: BalanceLookupTarget,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const { family } = getPaymentNetworkContext(target.network);
  return family === "solana"
    ? resolveSolanaBalance(target, deps)
    : resolveEvmBalance(target, deps);
}

export async function resolveUsdcBalance(
  target: BalanceLookupTarget,
  deps: BalanceDeps,
): Promise<BalanceRecord> {
  return (await resolveByFamily(target, deps)).record;
}

function findMatchingRequirementAmount(
  accepts: { network: string; amount: string }[],
  network: PaymentNetwork,
): string | null {
  const configuredNetwork =
    getPaymentNetworkContext(network).family === "solana"
      ? clusterToCAIP2(getSolanaClusterForNetwork(network)).caip2
      : lookupX402Network(getEvmChainInfoForNetwork(network).id);
  return accepts.find((r) => r.network === configuredNetwork)?.amount ?? null;
}

export async function checkPreflightBalance(
  config: ResolvedConfig,
  firstAttempt: Extract<WrappedRunResult, { kind: "payment-required" }>,
  deps: PreflightBalanceDeps,
): Promise<void> {
  const { accepts } = await deps.parseRequirements(
    firstAttempt.response.clone(),
    firstAttempt.url,
  );
  const requiredRaw = findMatchingRequirementAmount(
    accepts,
    config.payment.network,
  );
  if (requiredRaw == null) {
    return;
  }

  const target: BalanceLookupTarget = {
    network: config.payment.network,
    address: config.payment.address,
    rpcUrl: config.payment.rpcUrl,
  };

  const { record, rawAmount } = await resolveByFamily(target, deps);
  if (rawAmount < BigInt(requiredRaw)) {
    const requiredFormatted = formatTokenAmount(requiredRaw, USDC_DECIMALS);
    throw new Error(
      `Insufficient USDC balance (have ${record.amount}, endpoint costs ${requiredFormatted})`,
    );
  }
}

export function validateAddressForNetwork(
  address: string,
  network: PaymentNetwork,
): void {
  const { family } = getPaymentNetworkContext(network);
  if (family === "solana") {
    try {
      new PublicKey(address);
    } catch {
      throw new ConfigError(`Invalid Solana address: ${address}`);
    }
    return;
  }
  if (!isAddress(address, { strict: false })) {
    throw new ConfigError(`Invalid EVM address: ${address}`);
  }
}

export function buildTargetFromOverrides(
  network: PaymentNetwork,
  address: string,
): BalanceLookupTarget {
  validateAddressForNetwork(address, network);
  return {
    network,
    address,
    rpcUrl: getPaymentNetworkDefaults(network).rpcUrl,
  };
}

async function getSolanaTokenBalanceDefault(
  rpcUrl: string,
  mint: string,
  owner: string,
): Promise<bigint> {
  type ParsedTokenAccountData = {
    parsed: {
      info: {
        tokenAmount: {
          amount: string;
        };
      };
    };
  };

  const connection = new Connection(rpcUrl, "confirmed");
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(mint) },
  );
  return tokenAccounts.value.reduce((sum, account) => {
    const parsed = account.account.data as ParsedTokenAccountData;
    return sum + BigInt(parsed.parsed.info.tokenAmount.amount);
  }, 0n);
}

const EVM_CHAINS: Record<
  number,
  Parameters<typeof createPublicClient>[0]["chain"]
> = {
  8453: base,
  84532: baseSepolia,
};

function getEvmPublicClientDefault(
  rpcUrl: string,
  chainId: number,
): PublicClient {
  const chain = EVM_CHAINS[chainId];
  if (chain == null) {
    throw new ConfigError(`Unsupported EVM chain ID: ${chainId}`);
  }
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

export const defaultBalanceDeps: BalanceDeps = {
  getSolanaTokenBalance: getSolanaTokenBalanceDefault,
  getEvmPublicClient: getEvmPublicClientDefault,
  lookupKnownSPLToken,
  lookupKnownAsset,
};

export const defaultPreflightBalanceDeps: PreflightBalanceDeps = {
  ...defaultBalanceDeps,
  parseRequirements: extractPaymentRequiredResponse,
};
