import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createPublicClient, http, isAddress, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { lookupKnownAsset } from "@faremeter/info/evm";
import { lookupKnownSPLToken } from "@faremeter/info/solana";
import { erc20 } from "@faremeter/payment-evm";
import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";
import { ConfigError } from "../config/index.js";
import type { PaymentNetwork, ResolvedConfig } from "../config/index.js";
import {
  formatPaymentNetworkDisplay,
  getPaymentNetworkContext,
  getPaymentNetworkDefaults,
} from "../config/schema.js";
import { formatTokenAmount } from "../output/format.js";
import { getEvmChainInfoForNetwork } from "./networks.js";
import {
  resolveKnownPaymentAsset,
  type KnownPaymentAssetDetails,
} from "./requirements.js";
import {
  extractPaymentRequiredResponse,
  formatPaymentRequirementMismatch,
  selectPaymentRequirement,
} from "./signer.js";
import type { WrappedRunResult } from "../process/wrapped-client.js";

const USDC_DECIMALS = 6;

export type BalanceLookupTarget = {
  network: PaymentNetwork;
  address: string;
  rpcURL: string;
};

export type BalanceRecord = {
  address: string;
  network: string;
  asset: string;
  assetAddress: string;
  amount: string;
};

type BalanceResolution = {
  record: BalanceRecord;
  rawAmount: bigint;
};

export type BalanceDeps = {
  getSolanaTokenBalance: (
    rpcURL: string,
    mint: string,
    owner: string,
  ) => Promise<bigint>;
  getEvmPublicClient: (rpcURL: string, chainId: number) => PublicClient;
  lookupKnownSPLToken: typeof lookupKnownSPLToken;
  lookupKnownAsset: typeof lookupKnownAsset;
};

export type PreflightBalanceDeps = BalanceDeps & {
  parseRequirements: (
    response: Response,
    url: string,
  ) => Promise<{ accepts: x402PaymentRequirementsV2[] }>;
  solanaTokenAccountExists: (
    rpcURL: string,
    mint: string,
    owner: string,
    tokenProgram?: string,
  ) => Promise<boolean>;
};

async function resolveSolanaBalance(
  target: BalanceLookupTarget,
  asset: KnownPaymentAssetDetails,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const rawAmount = await deps.getSolanaTokenBalance(
    target.rpcURL,
    asset.asset,
    target.address,
  );
  return {
    record: {
      address: target.address,
      network: formatPaymentNetworkDisplay(target.network),
      asset: asset.symbol,
      assetAddress: asset.asset,
      amount: formatTokenAmount(
        String(rawAmount),
        asset.decimals ?? USDC_DECIMALS,
      ),
    },
    rawAmount,
  };
}

async function resolveEvmBalance(
  target: BalanceLookupTarget,
  asset: KnownPaymentAssetDetails,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const chainInfo = getEvmChainInfoForNetwork(target.network);
  const client = deps.getEvmPublicClient(target.rpcURL, chainInfo.id);
  const result = await erc20.getTokenBalance({
    account: target.address as `0x${string}`,
    asset: asset.asset as `0x${string}`,
    client,
  });
  return {
    record: {
      address: target.address,
      network: formatPaymentNetworkDisplay(target.network),
      asset: asset.symbol,
      assetAddress: asset.asset,
      amount: formatTokenAmount(String(result.amount), result.decimals),
    },
    rawAmount: result.amount,
  };
}

function resolveByFamily(
  target: BalanceLookupTarget,
  asset: KnownPaymentAssetDetails,
  deps: BalanceDeps,
): Promise<BalanceResolution> {
  const { family } = getPaymentNetworkContext(target.network);
  return family === "solana"
    ? resolveSolanaBalance(target, asset, deps)
    : resolveEvmBalance(target, asset, deps);
}

export async function resolveAssetBalance(
  target: BalanceLookupTarget,
  asset: KnownPaymentAssetDetails,
  deps: BalanceDeps,
): Promise<BalanceRecord> {
  return (await resolveByFamily(target, asset, deps)).record;
}

export async function resolveUsdcBalance(
  target: BalanceLookupTarget,
  deps: BalanceDeps,
): Promise<BalanceRecord> {
  return resolveAssetBalance(
    target,
    resolveKnownPaymentAsset(target.network, "USDC"),
    deps,
  );
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
  const selection = selectPaymentRequirement({
    accepts,
    config,
  });
  if (selection.kind !== "selected") {
    throw new Error(formatPaymentRequirementMismatch(config, selection));
  }

  const target: BalanceLookupTarget = {
    network: config.payment.network,
    address: config.payment.address,
    rpcURL: config.payment.rpcURL,
  };

  const requiredRaw = selection.selected.requirement.amount;
  const { family } = getPaymentNetworkContext(target.network);
  if (family === "solana") {
    const tokenProgram =
      typeof selection.selected.requirement.extra === "object" &&
      selection.selected.requirement.extra != null &&
      "tokenProgram" in selection.selected.requirement.extra &&
      typeof selection.selected.requirement.extra.tokenProgram === "string"
        ? selection.selected.requirement.extra.tokenProgram
        : undefined;
    const receiverAccountExists = await deps.solanaTokenAccountExists(
      target.rpcURL,
      selection.selected.asset,
      selection.selected.requirement.payTo,
      tokenProgram,
    );
    if (!receiverAccountExists) {
      throw new Error(
        `Endpoint advertises ${selection.selected.symbol ?? selection.selected.asset} on ${formatPaymentNetworkDisplay(target.network)}, but the receiver token account is not initialized yet`,
      );
    }
  }

  const balance =
    family === "solana"
      ? await deps.getSolanaTokenBalance(
          target.rpcURL,
          selection.selected.asset,
          target.address,
        )
      : (
          await erc20.getTokenBalance({
            account: target.address as `0x${string}`,
            asset: selection.selected.asset as `0x${string}`,
            client: deps.getEvmPublicClient(
              target.rpcURL,
              getEvmChainInfoForNetwork(target.network).id,
            ),
          })
        ).amount;

  if (balance < BigInt(requiredRaw)) {
    const requiredFormatted = formatTokenAmount(
      requiredRaw,
      selection.selected.decimals ?? USDC_DECIMALS,
    );
    const haveFormatted = formatTokenAmount(
      String(balance),
      selection.selected.decimals ?? USDC_DECIMALS,
    );
    throw new Error(
      `Insufficient ${selection.selected.symbol ?? selection.selected.asset} balance (have ${haveFormatted}, endpoint costs ${requiredFormatted})`,
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
    rpcURL: getPaymentNetworkDefaults(network).rpcURL,
  };
}

async function getSolanaTokenBalanceDefault(
  rpcURL: string,
  mint: string,
  owner: string,
): Promise<bigint> {
  const connection = new Connection(rpcURL, "confirmed");
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(mint) },
  );
  return tokenAccounts.value.reduce((sum, account) => {
    return sum + BigInt(readParsedTokenAmount(account.account.data));
  }, 0n);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readParsedTokenAmount(data: unknown): string {
  if (!isRecord(data)) {
    throw new ConfigError("Solana token account response is not parsed");
  }
  const { parsed } = data;
  if (!isRecord(parsed)) {
    throw new ConfigError(
      "Solana token account response is missing parsed data",
    );
  }
  const { info } = parsed;
  if (!isRecord(info)) {
    throw new ConfigError(
      "Solana token account response is missing token info",
    );
  }
  const { tokenAmount } = info;
  if (!isRecord(tokenAmount) || typeof tokenAmount.amount !== "string") {
    throw new ConfigError(
      "Solana token account response is missing token amount",
    );
  }
  return tokenAmount.amount;
}

async function solanaTokenAccountExistsDefault(
  rpcURL: string,
  mint: string,
  owner: string,
  tokenProgram?: string,
): Promise<boolean> {
  const connection = new Connection(rpcURL, "confirmed");
  const account = getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    true,
    tokenProgram == null ? TOKEN_PROGRAM_ID : new PublicKey(tokenProgram),
  );
  return (await connection.getAccountInfo(account)) != null;
}

const EVM_CHAINS: Record<
  number,
  Parameters<typeof createPublicClient>[0]["chain"]
> = {
  8453: base,
  84532: baseSepolia,
};

function getEvmPublicClientDefault(
  rpcURL: string,
  chainId: number,
): PublicClient {
  const chain = EVM_CHAINS[chainId];
  if (chain == null) {
    throw new ConfigError(`Unsupported EVM chain ID: ${chainId}`);
  }
  return createPublicClient({ chain, transport: http(rpcURL) });
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
  solanaTokenAccountExists: solanaTokenAccountExistsDefault,
};
