import fs from "node:fs/promises";
import { normalizeNetworkId, translateNetworkToLegacy } from "@faremeter/info";
import { lookupKnownAsset, lookupX402Network } from "@faremeter/info/evm";
import { clusterToCAIP2, lookupKnownSPLToken } from "@faremeter/info/solana";
import { exact as evmExact } from "@faremeter/payment-evm";
import { exact as solanaExact } from "@faremeter/payment-solana";
import type { PaymentHandler } from "@faremeter/types/client";
import { adaptPaymentRequiredResponseV1ToV2 } from "@faremeter/types/x402-adapters";
import {
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
  normalizePaymentRequiredResponse,
  normalizeSettleResponse,
  x402SettleResponseLenient,
  x402PaymentRequiredResponseLenient,
  type x402PaymentPayload as x402PaymentPayloadV1,
} from "@faremeter/types/x402";
import {
  V2_PAYMENT_HEADER,
  V2_PAYMENT_RESPONSE_HEADER,
  V2_PAYMENT_REQUIRED_HEADER,
  type x402PaymentPayload,
  type x402ResourceInfo,
  x402PaymentRequiredResponse as x402PaymentRequiredResponseV2,
  type x402PaymentRequirements as x402PaymentRequirementsV2,
} from "@faremeter/types/x402v2";
import { createLocalWallet as createEvmLocalWallet } from "@faremeter/wallet-evm";
import { createLocalWallet as createSolanaLocalWallet } from "@faremeter/wallet-solana";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { ConfigError } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { buildOwsPaymentHandler } from "./ows.js";
import { getEvmChainInfo, getSolanaCluster } from "./networks.js";

import type { RetryHeader } from "../process/wrapped-client.js";
export type { RetryHeader } from "../process/wrapped-client.js";

export type PaymentHandlerInfo = {
  handler: PaymentHandler;
  network: string;
};

export type PaymentMetadata = {
  amount: string;
  asset: string;
  network: string;
  decimals?: number;
  txSignature?: string;
};

export type PaymentRetryHeaderResult = {
  detectedVersion: 1 | 2;
  header: RetryHeader;
  paymentInfo: PaymentMetadata;
};

type SolanaPaymentInfo = {
  cluster: "mainnet-beta" | "devnet";
  mint: PublicKey;
  network: string;
  asset: string;
};

type EvmPaymentInfo = {
  chainInfo: {
    id: number;
    name: string;
  };
  network: string;
  asset: string;
  assetInfo: NonNullable<ReturnType<typeof lookupKnownAsset>>;
};

type BuildPaymentHandlerDeps = {
  readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  buildOwsPaymentHandler: typeof buildOwsPaymentHandler;
  createSolanaLocalWallet: typeof createSolanaLocalWallet;
  createEvmLocalWallet: typeof createEvmLocalWallet;
  createSolanaPaymentHandler: typeof solanaExact.createPaymentHandler;
  createEvmPaymentHandler: typeof evmExact.createPaymentHandler;
  createConnection: (rpcUrl: string) => Connection;
  lookupKnownSPLToken: typeof lookupKnownSPLToken;
  clusterToCAIP2: typeof clusterToCAIP2;
  lookupKnownAsset: typeof lookupKnownAsset;
  lookupX402Network: typeof lookupX402Network;
};

type BuildPaymentRetryHeaderArgs = {
  config: ResolvedConfig;
  response: Response;
  url: string;
  requestInit: RequestInit;
};

type BuildPaymentRetryHeaderDeps = {
  buildPaymentHandler: typeof buildPaymentHandler;
};

export type ParsedPaymentRequiredResponse = {
  detectedVersion: 1 | 2;
  accepts: x402PaymentRequirementsV2[];
  resource?: x402ResourceInfo;
};

type PaymentHandlerStrategy = {
  matches: (config: ResolvedConfig) => boolean;
  build: (
    config: ResolvedConfig,
    deps: BuildPaymentHandlerDeps,
  ) => Promise<PaymentHandlerInfo>;
};

const SOLANA_PAYMENT_HANDLER_OPTIONS = {
  token: {
    // Some x402 facilitators use PDA-owned settlement addresses as `payTo`.
    // SPL ATA derivation must allow off-curve owners for those recipients.
    allowOwnerOffCurve: true,
  },
} as const;

function resolveSolanaPaymentInfo(
  config: ResolvedConfig,
  deps: Pick<BuildPaymentHandlerDeps, "lookupKnownSPLToken" | "clusterToCAIP2">,
): SolanaPaymentInfo {
  const cluster = getSolanaCluster(config);
  const tokenInfo = deps.lookupKnownSPLToken(cluster, "USDC");
  if (tokenInfo == null) {
    throw new ConfigError(`No known USDC mint for Solana cluster ${cluster}`);
  }

  return {
    cluster,
    mint: new PublicKey(tokenInfo.address),
    network: deps.clusterToCAIP2(cluster).caip2,
    asset: tokenInfo.address,
  };
}

function resolveEvmPaymentInfo(
  config: ResolvedConfig,
  deps: Pick<BuildPaymentHandlerDeps, "lookupKnownAsset" | "lookupX402Network">,
): EvmPaymentInfo {
  const chainInfo = getEvmChainInfo(config);
  const assetInfo = deps.lookupKnownAsset(chainInfo.id, "USDC");
  if (assetInfo == null) {
    throw new ConfigError(
      `No known USDC asset for EVM network ${config.payment.network}`,
    );
  }

  return {
    chainInfo: { id: chainInfo.id, name: chainInfo.name },
    network: deps.lookupX402Network(chainInfo.id),
    asset: assetInfo.address,
    assetInfo,
  };
}

function requireHexPrivateKey(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new ConfigError(
      "configured EVM private key file does not contain a valid 32-byte hex key",
    );
  }
  return normalized;
}

function parseSolanaSecretKey(value: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(
      "configured Solana keypair file does not contain valid JSON",
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => !Number.isInteger(item))
  ) {
    throw new ConfigError(
      "configured Solana keypair file must contain an array of secret key bytes",
    );
  }

  return Uint8Array.from(parsed);
}

async function readActiveWalletSecret(
  config: ResolvedConfig,
  deps: Pick<BuildPaymentHandlerDeps, "readTextFile">,
): Promise<string> {
  if (config.activeWallet.kind !== "keypair") {
    throw new ConfigError("active wallet does not use a local keypair file");
  }
  return deps.readTextFile(config.activeWallet.expandedPath, "utf8");
}

async function buildSolanaKeypairHandler(
  config: ResolvedConfig,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  if (config.activeWallet.kind !== "keypair") {
    throw new ConfigError("Solana keypair handler requires a keypair wallet");
  }

  const paymentInfo = resolveSolanaPaymentInfo(config, deps);
  const secretKeyText = await readActiveWalletSecret(config, deps);
  const keypair = Keypair.fromSecretKey(parseSolanaSecretKey(secretKeyText));
  const wallet = await deps.createSolanaLocalWallet(
    paymentInfo.cluster,
    keypair,
  );
  const connection = deps.createConnection(config.payment.rpcUrl);

  return {
    handler: deps.createSolanaPaymentHandler(
      wallet,
      paymentInfo.mint,
      connection,
      SOLANA_PAYMENT_HANDLER_OPTIONS,
    ),
    network: paymentInfo.network,
  };
}

async function buildEvmKeypairHandler(
  config: ResolvedConfig,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  if (config.activeWallet.kind !== "keypair") {
    throw new ConfigError("EVM keypair handler requires a keypair wallet");
  }

  const paymentInfo = resolveEvmPaymentInfo(config, deps);
  const privateKeyText = await readActiveWalletSecret(config, deps);
  const wallet = await deps.createEvmLocalWallet(
    paymentInfo.chainInfo,
    requireHexPrivateKey(privateKeyText),
  );

  return {
    handler: deps.createEvmPaymentHandler(wallet, {
      asset: paymentInfo.assetInfo,
    }),
    network: paymentInfo.network,
  };
}

function parsePaymentRequiredBody(text: string) {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (cause) {
    throw new Error("failed to parse x402 payment challenge body as JSON", {
      cause,
    });
  }

  const normalized = normalizePaymentRequiredResponse(
    x402PaymentRequiredResponseLenient.assert(parsedJson),
  );
  return normalized;
}

function decodePaymentRequiredHeaderValue(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function parsePaymentRequiredHeaderValue(
  value: string,
): ParsedPaymentRequiredResponse {
  try {
    const parsed = x402PaymentRequiredResponseV2.assert(
      JSON.parse(decodePaymentRequiredHeaderValue(value)) as unknown,
    );
    return {
      detectedVersion: 2,
      accepts: parsed.accepts,
      resource: parsed.resource,
    };
  } catch (cause) {
    throw new Error("failed to parse x402 payment challenge header", {
      cause,
    });
  }
}

export async function extractPaymentRequiredResponse(
  response: Response,
  url: string,
) {
  const paymentRequiredHeader =
    response.headers.get(V2_PAYMENT_REQUIRED_HEADER) ??
    response.headers.get("X-PAYMENT-REQUIRED");

  if (paymentRequiredHeader != null && paymentRequiredHeader.length > 0) {
    return parsePaymentRequiredHeaderValue(paymentRequiredHeader);
  }

  try {
    const parsed = parsePaymentRequiredBody(await response.text());
    const adapted = adaptPaymentRequiredResponseV1ToV2(
      parsed,
      url,
      normalizeNetworkId,
    );
    return {
      detectedVersion: 1,
      accepts: adapted.accepts,
      resource: adapted.resource,
    };
  } catch (cause) {
    throw new Error("invalid x402 payment challenge", { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function extractRequirementDecimals(
  requirement: x402PaymentRequirementsV2,
): number | undefined {
  if (!isRecord(requirement.extra)) {
    return undefined;
  }

  const { decimals } = requirement.extra;
  return typeof decimals === "number" ? decimals : undefined;
}

function getRequirementNetworkFamily(network: string): "solana" | "evm" | null {
  const normalized = normalizeNetworkId(network);
  if (normalized.startsWith("solana:")) return "solana";
  if (normalized.startsWith("eip155:")) return "evm";
  return null;
}

function formatPaymentRequirementMismatch(
  config: ResolvedConfig,
  accepts: x402PaymentRequirementsV2[],
): string {
  const acceptedNetworks = accepts.map((requirement) =>
    normalizeNetworkId(requirement.network),
  );
  const acceptedFamilies = new Set(
    acceptedNetworks
      .map((network) => getRequirementNetworkFamily(network))
      .filter((family) => family != null),
  );

  if (
    acceptedFamilies.size === 1 &&
    acceptedFamilies.has("solana") &&
    config.payment.family !== "solana"
  ) {
    return `server only offered Solana x402 payment requirements (${acceptedNetworks.join(", ")}), but the active payment network is ${config.payment.network}; switch to a Solana network to call this endpoint`;
  }

  if (
    acceptedFamilies.size === 1 &&
    acceptedFamilies.has("evm") &&
    config.payment.family !== "evm"
  ) {
    return `server only offered EVM x402 payment requirements (${acceptedNetworks.join(", ")}), but the active payment network is ${config.payment.network}; switch to an EVM network to call this endpoint`;
  }

  return `server did not provide a supported x402 payment requirement for active payment network ${config.payment.network}; offered networks: ${acceptedNetworks.join(", ")}`;
}

function parseJsonText(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parsePaymentResponseHeaderValue(value: string): unknown {
  try {
    return parseJsonText(value);
  } catch {
    return parseJsonText(Buffer.from(value, "base64").toString("utf8"));
  }
}

function extractSettledTransaction(value: string): string | undefined {
  try {
    const parsed = parsePaymentResponseHeaderValue(value);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const normalized = normalizeSettleResponse(
      x402SettleResponseLenient.assert(parsed),
    );
    return normalized.transaction;
  } catch {
    return undefined;
  }
}

export function extractPaymentResponseTransaction(
  headers: Headers,
): string | undefined {
  const paymentResponse =
    headers.get(V2_PAYMENT_RESPONSE_HEADER) ??
    headers.get(X_PAYMENT_RESPONSE_HEADER);

  if (paymentResponse == null || paymentResponse.length === 0) {
    return undefined;
  }

  return extractSettledTransaction(paymentResponse);
}

function createOwsPaymentHandlerStrategy(): PaymentHandlerStrategy {
  return {
    matches: (config) => config.activeWallet.kind === "ows",
    build: async (config, deps) => deps.buildOwsPaymentHandler(config),
  };
}

function createSolanaKeypairPaymentHandlerStrategy(): PaymentHandlerStrategy {
  return {
    matches: (config) =>
      config.activeWallet.family === "solana" &&
      config.activeWallet.kind === "keypair",
    build: buildSolanaKeypairHandler,
  };
}

function createEvmKeypairPaymentHandlerStrategy(): PaymentHandlerStrategy {
  return {
    matches: (config) =>
      config.activeWallet.family === "evm" &&
      config.activeWallet.kind === "keypair",
    build: buildEvmKeypairHandler,
  };
}

function getPaymentHandlerStrategies(): PaymentHandlerStrategy[] {
  return [
    createSolanaKeypairPaymentHandlerStrategy(),
    createEvmKeypairPaymentHandlerStrategy(),
    createOwsPaymentHandlerStrategy(),
  ];
}

async function resolvePaymentHandler(
  config: ResolvedConfig,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  for (const strategy of getPaymentHandlerStrategies()) {
    if (strategy.matches(config)) {
      return strategy.build(config, deps);
    }
  }

  throw new ConfigError(
    `unsupported active wallet family ${config.activeWallet.family}`,
  );
}

export function createBuildPaymentHandler(deps: BuildPaymentHandlerDeps) {
  return async function buildPaymentHandler(
    config: ResolvedConfig,
  ): Promise<PaymentHandlerInfo> {
    return resolvePaymentHandler(config, deps);
  };
}

export function createBuildPaymentRetryHeader(
  deps: BuildPaymentRetryHeaderDeps,
) {
  return async function buildPaymentRetryHeader(
    args: BuildPaymentRetryHeaderArgs,
  ): Promise<PaymentRetryHeaderResult> {
    const paymentRequired = await extractPaymentRequiredResponse(
      args.response,
      args.url,
    );
    const { handler } = await deps.buildPaymentHandler(args.config);
    const execers = await handler(
      { request: new Request(args.url, args.requestInit) },
      paymentRequired.accepts,
    );
    const execer = execers[0];
    if (execer == null) {
      throw new Error(
        formatPaymentRequirementMismatch(args.config, paymentRequired.accepts),
      );
    }

    const { payload } = await execer.exec();
    const decimals = extractRequirementDecimals(execer.requirements);
    const header =
      paymentRequired.detectedVersion === 2
        ? {
            name: V2_PAYMENT_HEADER,
            value: Buffer.from(
              JSON.stringify({
                x402Version: 2,
                accepted: execer.requirements,
                payload,
                ...(paymentRequired.resource == null
                  ? {}
                  : { resource: paymentRequired.resource }),
              } satisfies x402PaymentPayload),
              "utf8",
            ).toString("base64"),
          }
        : {
            name: X_PAYMENT_HEADER,
            value: Buffer.from(
              JSON.stringify({
                x402Version: 1,
                scheme: execer.requirements.scheme,
                network: translateNetworkToLegacy(execer.requirements.network),
                asset: execer.requirements.asset,
                payload,
              } satisfies x402PaymentPayloadV1),
              "utf8",
            ).toString("base64"),
          };

    return {
      detectedVersion:
        paymentRequired.detectedVersion as PaymentRetryHeaderResult["detectedVersion"],
      header,
      paymentInfo: {
        amount: execer.requirements.amount,
        asset: execer.requirements.asset,
        network: execer.requirements.network,
        ...(decimals == null ? {} : { decimals }),
      },
    };
  };
}

export const buildPaymentHandler = createBuildPaymentHandler({
  readTextFile: fs.readFile,
  buildOwsPaymentHandler,
  createSolanaLocalWallet,
  createEvmLocalWallet,
  createSolanaPaymentHandler: solanaExact.createPaymentHandler,
  createEvmPaymentHandler: evmExact.createPaymentHandler,
  createConnection: (rpcUrl) => new Connection(rpcUrl, "confirmed"),
  lookupKnownSPLToken,
  clusterToCAIP2,
  lookupKnownAsset,
  lookupX402Network,
});

export const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
  buildPaymentHandler,
});
