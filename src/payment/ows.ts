import {
  getWallet,
  signTransaction as owsSignTransaction,
  signTypedData as owsSignTypedData,
  type AccountInfo,
  type WalletInfo,
} from "@open-wallet-standard/core";
import { lookupKnownAsset, lookupX402Network } from "@faremeter/info/evm";
import { clusterToCAIP2, lookupKnownSPLToken } from "@faremeter/info/solana";
import { exact as evmExact } from "@faremeter/payment-evm";
import { getTokenBalance as getErc20Balance } from "@faremeter/payment-evm/erc20";
import { exact as solanaExact } from "@faremeter/payment-solana";
import type { WalletAdapter } from "@faremeter/rides";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  type VersionedTransaction,
} from "@solana/web3.js";
import {
  createPublicClient,
  fromHex,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ConfigError } from "../config/index.js";
import type {
  ResolvedConfig,
  ResolvedWallet,
  WalletFamily,
} from "../config/index.js";

type EvmChainInfo = {
  id: number;
  name: string;
  owsChain: string;
  viemChain: Chain;
};

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

const EVM_CHAIN_INFO: Record<string, EvmChainInfo> = {
  base: {
    id: 8453,
    name: "Base",
    owsChain: "base",
    viemChain: base,
  },
  "base-sepolia": {
    id: 84532,
    name: "Base Sepolia",
    owsChain: "base",
    viemChain: baseSepolia,
  },
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
  tx: VersionedTransaction,
  publicKey: PublicKey,
  deps: Pick<OwsDeps, "signTransaction">,
): void {
  const txHex = Buffer.from(tx.serialize()).toString("hex");
  const { signature } = deps.signTransaction(walletId, "solana", txHex);
  tx.addSignature(
    publicKey,
    fromHex(
      requireHex(
        signature,
        `OWS returned an invalid Solana signature for ${walletId}`,
      ),
      "bytes",
    ),
  );
}

async function getSplTokenBalanceWithConnection(args: {
  connection: Connection;
  account: string;
  asset: string;
}): Promise<{ amount: bigint; decimals: number } | null> {
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(args.asset),
    new PublicKey(args.account),
  );

  try {
    const tokenAmount = await args.connection.getTokenAccountBalance(
      ata,
      "confirmed",
    );

    return {
      amount: BigInt(tokenAmount.value.amount),
      decimals: tokenAmount.value.decimals,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TokenAccountNotFoundError" ||
        error.name === "AccountNotFoundError" ||
        error.message.includes("could not find account"))
    ) {
      return null;
    }

    throw error;
  }
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

function getWalletAccountForFamily(
  wallet: WalletInfo,
  family: WalletFamily,
): AccountInfo {
  const prefix = OWS_ACCOUNT_CHAIN_PREFIX[family];
  const account = wallet.accounts.find(({ chainId }) =>
    chainId.startsWith(prefix),
  );
  if (account == null) {
    throw new ConfigError(
      `OWS wallet ${wallet.name} does not contain a ${family} account`,
    );
  }
  return account;
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
  const account = getWalletAccountForFamily(wallet, config.activeWallet.family);

  if (!walletAddressesMatch(config.activeWallet, account)) {
    throw new ConfigError(
      `Configured ${config.activeWallet.family} address ${config.activeWallet.address} does not match OWS wallet ${wallet.name} address ${account.address}`,
    );
  }

  return {
    account,
    walletId: wallet.id,
  };
}

function getSolanaCluster(config: ResolvedConfig): "mainnet-beta" | "devnet" {
  switch (config.payment.network) {
    case "mainnet-beta":
      return "mainnet-beta";
    case "devnet":
      return "devnet";
    default:
      throw new ConfigError(
        `OWS Solana payments do not support network ${config.payment.network}`,
      );
  }
}

function getEvmChainInfo(config: ResolvedConfig): EvmChainInfo {
  const chainInfo = EVM_CHAIN_INFO[config.payment.network];
  if (chainInfo == null) {
    throw new ConfigError(
      `OWS EVM payments do not support network ${config.payment.network}`,
    );
  }
  return chainInfo;
}

export type OwsDeps = {
  getWallet: typeof getWallet;
  signTransaction: typeof owsSignTransaction;
  signTypedData: typeof owsSignTypedData;
  createConnection: (rpcUrl: string) => Connection;
  createPublicClient: (parameters: {
    chain: Chain;
    transport: ReturnType<typeof http>;
  }) => PublicClient;
  lookupKnownSPLToken: typeof lookupKnownSPLToken;
  clusterToCAIP2: typeof clusterToCAIP2;
  lookupKnownAsset: typeof lookupKnownAsset;
  lookupX402Network: typeof lookupX402Network;
  createSolanaPaymentHandler: typeof solanaExact.createPaymentHandler;
  createEvmPaymentHandler: typeof evmExact.createPaymentHandler;
  getErc20Balance: typeof getErc20Balance;
};

function buildSolanaWalletAdapter(
  cluster: "mainnet-beta" | "devnet",
  walletId: string,
  publicKey: PublicKey,
  deps: Pick<OwsDeps, "signTransaction">,
) {
  return {
    network: cluster,
    publicKey,
    partiallySignTransaction: async (tx: VersionedTransaction) => {
      signSolanaTransactionWithOws(walletId, tx, publicKey, deps);
      return tx;
    },
  };
}

function createSolanaOwsAdapter(
  config: ResolvedConfig,
  walletAccount: OwsWalletAccount,
  deps: OwsDeps,
): WalletAdapter {
  const cluster = getSolanaCluster(config);
  const tokenInfo = deps.lookupKnownSPLToken(cluster, "USDC");
  if (tokenInfo == null) {
    throw new ConfigError(`No known USDC mint for Solana cluster ${cluster}`);
  }

  const publicKey = new PublicKey(walletAccount.account.address);
  const connection = deps.createConnection(config.payment.rpcUrl);
  const mint = new PublicKey(tokenInfo.address);
  const wallet = buildSolanaWalletAdapter(
    cluster,
    walletAccount.walletId,
    publicKey,
    deps,
  );
  const x402Id = [
    {
      scheme: "exact",
      network: deps.clusterToCAIP2(cluster).caip2,
      asset: tokenInfo.address,
    },
  ];

  return {
    x402Id,
    paymentHandler: deps.createSolanaPaymentHandler(wallet, mint, connection),
    getBalance: async () => {
      const balance = await getSplTokenBalanceWithConnection({
        connection,
        account: walletAccount.account.address,
        asset: tokenInfo.address,
      });

      return {
        amount: balance?.amount ?? 0n,
        decimals: balance?.decimals ?? 0,
        name: tokenInfo.name,
      };
    },
  };
}

function buildEvmWalletAdapter(
  walletId: string,
  chainInfo: EvmChainInfo,
  address: Hex,
  deps: OwsDeps,
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

function createEvmOwsAdapter(
  config: ResolvedConfig,
  walletAccount: OwsWalletAccount,
  deps: OwsDeps,
): WalletAdapter {
  const chainInfo = getEvmChainInfo(config);
  const assetInfo = deps.lookupKnownAsset(chainInfo.id, "USDC");
  if (assetInfo == null) {
    throw new ConfigError(
      `No known USDC asset for EVM network ${config.payment.network}`,
    );
  }

  const address = requireEvmAddress(
    walletAccount.account.address,
    `OWS wallet returned an invalid EVM address for ${walletAccount.account.chainId}`,
  );
  const publicClient = deps.createPublicClient({
    chain: chainInfo.viemChain,
    transport: http(config.payment.rpcUrl),
  });
  const wallet = buildEvmWalletAdapter(
    walletAccount.walletId,
    chainInfo,
    address,
    deps,
  );
  const x402Id = [
    {
      scheme: "exact",
      network: deps.lookupX402Network(chainInfo.id),
      asset: assetInfo.address,
    },
  ];

  return {
    x402Id,
    paymentHandler: deps.createEvmPaymentHandler(wallet, {
      asset: assetInfo,
    }),
    getBalance: async () => {
      const balance = await deps.getErc20Balance({
        account: address,
        asset: assetInfo.address,
        client: publicClient,
      });

      return {
        ...balance,
        name: assetInfo.contractName,
      };
    },
  };
}

export function createBuildOwsAdapter(deps: OwsDeps) {
  return async function buildOwsAdapter(
    config: ResolvedConfig,
  ): Promise<WalletAdapter> {
    const walletAccount = getOwsWalletAccount(config, deps);

    if (config.activeWallet.family === "solana") {
      return createSolanaOwsAdapter(config, walletAccount, deps);
    }

    return createEvmOwsAdapter(config, walletAccount, deps);
  };
}

export const buildOwsAdapter = createBuildOwsAdapter({
  getWallet,
  signTransaction: owsSignTransaction,
  signTypedData: owsSignTypedData,
  createConnection: (rpcUrl) => new Connection(rpcUrl, "confirmed"),
  createPublicClient,
  lookupKnownSPLToken,
  clusterToCAIP2,
  lookupKnownAsset,
  lookupX402Network,
  createSolanaPaymentHandler: solanaExact.createPaymentHandler,
  createEvmPaymentHandler: evmExact.createPaymentHandler,
  getErc20Balance,
});
