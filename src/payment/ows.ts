import {
  getWallet,
  signTransaction as owsSignTransaction,
  signTypedData as owsSignTypedData,
  type AccountInfo,
  type WalletInfo,
} from "@open-wallet-standard/core";
import {
  address,
  getBase64EncodedWireTransaction,
  type Address,
  type Transaction,
} from "@solana/kit";
import { fromHex, isAddress, isAddressEqual, isHex, type Hex } from "viem";
import {
  isKnownAsset,
  lookupKnownAsset,
  lookupX402Network,
} from "@faremeter/info/evm";
import { clusterToCAIP2, lookupKnownSPLToken } from "@faremeter/info/solana";
import { exact as evmExact } from "@faremeter/payment-evm";
import { exact as solanaExact } from "@faremeter/payment-solana";
import type { PaymentHandler } from "@faremeter/types/client";

import { ConfigError } from "../config/index.js";
import type {
  ResolvedConfig,
  ResolvedWallet,
  WalletFamily,
} from "../config/index.js";
import type { PaymentRequirementDetails } from "./requirements.js";
import {
  type EvmChainInfo,
  getEvmChainInfo,
  getSolanaCluster,
} from "./networks.js";

type OwsWalletAccount = {
  account: AccountInfo;
  walletId: string;
};

type Eip712TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type OwsPaymentHandler = {
  handler: PaymentHandler;
  network: string;
};

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const OWS_ACCOUNT_CHAIN_PREFIX: Record<WalletFamily, string> = {
  evm: "eip155:",
  solana: "solana:",
};

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function requireHex(value: string, message: string): Hex {
  const normalized = normalizeHex(value);
  if (!isHex(normalized)) {
    throw new ConfigError(message);
  }
  return normalized;
}

function requireEvmAddress(value: string, message: string): Hex {
  const normalized = normalizeHex(value);
  if (!isAddress(normalized, { strict: false })) {
    throw new ConfigError(message);
  }
  return normalized;
}

function signSolanaTransactionWithOws(
  walletId: string,
  tx: Transaction,
  publicKey: Address,
  deps: Pick<OwsDeps, "signTransaction">,
): Transaction {
  const txHex = Buffer.from(
    getBase64EncodedWireTransaction(tx),
    "base64",
  ).toString("hex");
  const { signature } = deps.signTransaction(walletId, "solana", txHex);
  const signatureBytes = fromHex(
    requireHex(
      signature,
      `OWS returned an invalid Solana signature for ${walletId}`,
    ),
    "bytes",
  );
  if (signatureBytes.length !== 64) {
    throw new ConfigError(
      `OWS returned an invalid Solana signature for ${walletId}`,
    );
  }

  return {
    ...tx,
    signatures: Object.freeze({
      ...tx.signatures,
      [publicKey]: signatureBytes,
    }),
  };
}

function normalizeTypedDataForOws(value: unknown): unknown {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("types" in value)
  ) {
    return value;
  }

  const types = value.types;
  if (types == null || typeof types !== "object" || Array.isArray(types)) {
    return value;
  }

  if ("EIP712Domain" in types) {
    return value;
  }

  return {
    ...value,
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      ...types,
    },
  };
}

function stringifyTypedData(value: unknown): string {
  return JSON.stringify(
    normalizeTypedDataForOws(value),
    (_key, fieldValue: unknown) =>
      typeof fieldValue === "bigint" ? fieldValue.toString() : fieldValue,
  );
}

function getWalletAccountsForFamily(
  wallet: WalletInfo,
  family: WalletFamily,
): AccountInfo[] {
  const prefix = OWS_ACCOUNT_CHAIN_PREFIX[family];
  const accounts = wallet.accounts.filter(({ chainId }) =>
    chainId.startsWith(prefix),
  );
  if (accounts.length === 0) {
    throw new ConfigError(
      `OWS wallet ${wallet.name} does not contain a ${family} account`,
    );
  }
  return accounts;
}

function walletAddressesMatch(
  wallet: ResolvedWallet,
  account: AccountInfo,
): boolean {
  if (wallet.family === "evm") {
    const configuredAddress = requireEvmAddress(
      wallet.address,
      `Configured EVM wallet address is invalid: ${wallet.address}`,
    );
    const walletAddress = requireEvmAddress(
      account.address,
      `OWS wallet returned an invalid EVM address for ${account.chainId}`,
    );
    return isAddressEqual(configuredAddress, walletAddress);
  }

  return wallet.address === account.address;
}

function getOwsWalletAccount(
  config: ResolvedConfig,
  deps: Pick<OwsDeps, "getWallet">,
): OwsWalletAccount {
  if (config.activeWallet.kind !== "ows") {
    throw new ConfigError("OWS adapter requires an active OWS wallet");
  }

  const wallet = deps.getWallet(config.activeWallet.walletId);
  const account = getWalletAccountsForFamily(
    wallet,
    config.activeWallet.family,
  ).find((candidate) => walletAddressesMatch(config.activeWallet, candidate));

  if (account == null) {
    throw new ConfigError(
      `Configured ${config.activeWallet.family} address ${config.activeWallet.address} does not match any ${config.activeWallet.family} account in OWS wallet ${wallet.name}`,
    );
  }

  return {
    account,
    walletId: wallet.id,
  };
}

export type OwsDeps = {
  getWallet: typeof getWallet;
  signTransaction: typeof owsSignTransaction;
  signTypedData: typeof owsSignTypedData;
  lookupKnownSPLToken: typeof lookupKnownSPLToken;
  clusterToCAIP2: typeof clusterToCAIP2;
  lookupKnownAsset: typeof lookupKnownAsset;
  lookupX402Network: typeof lookupX402Network;
  createSolanaPaymentHandler: typeof solanaExact.createPaymentHandler;
  createEvmPaymentHandler: typeof evmExact.createPaymentHandler;
};

function buildSolanaOwsWallet(
  cluster: "mainnet-beta" | "devnet",
  walletId: string,
  publicKey: Address,
  deps: Pick<OwsDeps, "signTransaction">,
) {
  return {
    network: cluster,
    publicKey,
    partiallySignTransaction: async (tx: Transaction) =>
      signSolanaTransactionWithOws(walletId, tx, publicKey, deps),
  };
}

function buildSolanaOwsPaymentHandler(
  config: ResolvedConfig,
  requirement: PaymentRequirementDetails | undefined,
  walletAccount: OwsWalletAccount,
  deps: OwsDeps,
): OwsPaymentHandler {
  const cluster = getSolanaCluster(config);
  const tokenInfo = deps.lookupKnownSPLToken(cluster, "USDC");
  const asset = requirement?.asset ?? tokenInfo?.address;
  if (asset == null) {
    throw new ConfigError(`No known USDC mint for Solana cluster ${cluster}`);
  }

  const publicKey = address(walletAccount.account.address);
  const mint = address(asset);
  const wallet = buildSolanaOwsWallet(
    cluster,
    walletAccount.walletId,
    publicKey,
    deps,
  );

  return {
    handler: deps.createSolanaPaymentHandler(
      wallet,
      mint,
      config.payment.rpcURL,
    ),
    network: requirement?.network ?? deps.clusterToCAIP2(cluster).caip2,
  };
}

function buildEvmOwsWallet(
  walletId: string,
  chainInfo: EvmChainInfo,
  address: Hex,
  deps: Pick<OwsDeps, "signTypedData">,
) {
  return {
    chain: { id: chainInfo.id, name: chainInfo.name },
    address,
    account: {
      signTypedData: async (params: Eip712TypedData) =>
        requireHex(
          deps.signTypedData(
            walletId,
            chainInfo.owsChain,
            stringifyTypedData(params),
          ).signature,
          `OWS returned an invalid EVM signature for ${walletId}`,
        ),
    },
  };
}

function buildEvmOwsPaymentHandler(
  config: ResolvedConfig,
  requirement: PaymentRequirementDetails | undefined,
  walletAccount: OwsWalletAccount,
  deps: OwsDeps,
): OwsPaymentHandler {
  const chainInfo = getEvmChainInfo(config);
  if (requirement != null && requirement.symbol == null) {
    throw new ConfigError(
      `No known asset metadata for ${requirement.asset} on EVM network ${config.payment.network}`,
    );
  }

  const assetSymbol = requirement?.symbol ?? "USDC";
  if (!isKnownAsset(assetSymbol)) {
    throw new ConfigError(
      `No known ${assetSymbol} asset for EVM network ${config.payment.network}`,
    );
  }
  const assetInfo = deps.lookupKnownAsset(chainInfo.id, assetSymbol);
  if (assetInfo == null) {
    throw new ConfigError(
      `No known ${assetSymbol} asset for EVM network ${config.payment.network}`,
    );
  }

  const address = requireEvmAddress(
    walletAccount.account.address,
    `OWS wallet returned an invalid EVM address for ${walletAccount.account.chainId}`,
  );
  const wallet = buildEvmOwsWallet(
    walletAccount.walletId,
    chainInfo,
    address,
    deps,
  );

  return {
    handler: deps.createEvmPaymentHandler(wallet, { asset: assetInfo }),
    network: requirement?.network ?? deps.lookupX402Network(chainInfo.id),
  };
}

export function createBuildOwsPaymentHandler(deps: OwsDeps) {
  return async function buildOwsPaymentHandler(
    config: ResolvedConfig,
    requirement?: PaymentRequirementDetails,
  ): Promise<OwsPaymentHandler> {
    const walletAccount = getOwsWalletAccount(config, deps);

    if (config.activeWallet.family === "solana") {
      return buildSolanaOwsPaymentHandler(
        config,
        requirement,
        walletAccount,
        deps,
      );
    }

    return buildEvmOwsPaymentHandler(config, requirement, walletAccount, deps);
  };
}

export const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
  getWallet,
  signTransaction: owsSignTransaction,
  signTypedData: owsSignTypedData,
  lookupKnownSPLToken,
  clusterToCAIP2,
  lookupKnownAsset,
  lookupX402Network,
  createSolanaPaymentHandler: solanaExact.createPaymentHandler,
  createEvmPaymentHandler: evmExact.createPaymentHandler,
});
