import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { normalizeNetworkId, translateNetworkToLegacy } from "@faremeter/info";
import {
  isKnownAsset,
  lookupKnownAsset,
  lookupX402Network,
} from "@faremeter/info/evm";
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

import { ConfigError } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { formatPaymentNetworkDisplay } from "../config/schema.js";
import type { RetryHeader } from "../process/wrapped-client.js";
import { buildOwsPaymentHandler } from "./ows.js";
import { getEvmChainInfo, getSolanaCluster } from "./networks.js";
import {
  formatPaymentOptionNetwork,
  getPaymentRequirementDetails,
  type PaymentRequirementDetails,
} from "./requirements.js";
export type { RetryHeader } from "../process/wrapped-client.js";

export type PaymentHandlerInfo = {
  handler: PaymentHandler;
  network: string;
};

export type PaymentMetadata = {
  amount: string;
  asset: string;
  assetSymbol?: string;
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
  createConnection: (rpcURL: string) => Connection;
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
  extensions?: Record<string, unknown>;
};

export type PaymentRequirementSelection =
  | {
      kind: "selected";
      activeNetwork: string;
      requestedAsset: string;
      selected: PaymentRequirementDetails;
    }
  | {
      kind: "network-mismatch";
      activeNetwork: string;
      requestedAsset: string;
      options: PaymentRequirementDetails[];
    }
  | {
      kind: "asset-mismatch";
      activeNetwork: string;
      requestedAsset: string;
      options: PaymentRequirementDetails[];
    }
  | {
      kind: "asset-ambiguous";
      activeNetwork: string;
      requestedAsset: string;
      matches: PaymentRequirementDetails[];
    };

type PaymentHandlerStrategy = {
  matches: (config: ResolvedConfig) => boolean;
  build: (
    config: ResolvedConfig,
    requirement: PaymentRequirementDetails | undefined,
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
  requirement: PaymentRequirementDetails | undefined,
  deps: Pick<BuildPaymentHandlerDeps, "lookupKnownSPLToken" | "clusterToCAIP2">,
): SolanaPaymentInfo {
  const cluster = getSolanaCluster(config);
  const tokenInfo = deps.lookupKnownSPLToken(cluster, "USDC");
  const asset = requirement?.asset ?? tokenInfo?.address;
  if (asset == null) {
    throw new ConfigError(`No known USDC mint for Solana cluster ${cluster}`);
  }

  return {
    cluster,
    mint: new PublicKey(asset),
    network: requirement?.network ?? deps.clusterToCAIP2(cluster).caip2,
    asset,
  };
}

function resolveEvmPaymentInfo(
  config: ResolvedConfig,
  requirement: PaymentRequirementDetails | undefined,
  deps: Pick<BuildPaymentHandlerDeps, "lookupKnownAsset" | "lookupX402Network">,
): EvmPaymentInfo {
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

  return {
    chainInfo: { id: chainInfo.id, name: chainInfo.name },
    network: requirement?.network ?? deps.lookupX402Network(chainInfo.id),
    asset: requirement?.asset ?? assetInfo.address,
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
  requirement: PaymentRequirementDetails | undefined,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  if (config.activeWallet.kind !== "keypair") {
    throw new ConfigError("Solana keypair handler requires a keypair wallet");
  }

  const paymentInfo = resolveSolanaPaymentInfo(config, requirement, deps);
  const secretKeyText = await readActiveWalletSecret(config, deps);
  const keypair = Keypair.fromSecretKey(parseSolanaSecretKey(secretKeyText));
  const wallet = await deps.createSolanaLocalWallet(
    paymentInfo.cluster,
    keypair,
  );
  const connection = deps.createConnection(config.payment.rpcURL);

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
  requirement: PaymentRequirementDetails | undefined,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  if (config.activeWallet.kind !== "keypair") {
    throw new ConfigError("EVM keypair handler requires a keypair wallet");
  }

  const paymentInfo = resolveEvmPaymentInfo(config, requirement, deps);
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
  let parsedJSON: unknown;
  try {
    parsedJSON = JSON.parse(text);
  } catch (cause) {
    throw new Error("failed to parse x402 payment challenge body as JSON", {
      cause,
    });
  }

  const normalized = normalizePaymentRequiredResponse(
    x402PaymentRequiredResponseLenient.assert(parsedJSON),
  );
  return normalized;
}

function decodePaymentRequiredHeaderValue(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function parseDecodedPaymentRequiredValue(
  decoded: string,
  url: string,
): ParsedPaymentRequiredResponse {
  let parsedJSON: unknown;
  try {
    parsedJSON = JSON.parse(decoded);
  } catch (cause) {
    throw new Error("failed to parse x402 payment challenge header as JSON", {
      cause,
    });
  }

  try {
    const parsed = x402PaymentRequiredResponseV2.assert(parsedJSON);
    return {
      detectedVersion: 2,
      accepts: parsed.accepts,
      resource: parsed.resource,
      ...(isRecord(parsed.extensions) ? { extensions: parsed.extensions } : {}),
    };
  } catch {
    // Fall through and try the legacy v1 challenge shape.
  }

  try {
    const normalized = normalizePaymentRequiredResponse(
      x402PaymentRequiredResponseLenient.assert(parsedJSON),
    );
    const adapted = adaptPaymentRequiredResponseV1ToV2(
      normalized,
      url,
      normalizeNetworkId,
    );
    return {
      detectedVersion: 1,
      accepts: adapted.accepts,
      resource: adapted.resource,
    };
  } catch (cause) {
    throw new Error("failed to parse x402 payment challenge header", {
      cause,
    });
  }
}

function parsePaymentRequiredHeaderValue(
  value: string,
  url: string,
): ParsedPaymentRequiredResponse {
  return parseDecodedPaymentRequiredValue(
    decodePaymentRequiredHeaderValue(value),
    url,
  );
}

export async function extractPaymentRequiredResponse(
  response: Response,
  url: string,
): Promise<ParsedPaymentRequiredResponse> {
  const paymentRequiredHeader =
    response.headers.get(V2_PAYMENT_REQUIRED_HEADER) ??
    response.headers.get("X-PAYMENT-REQUIRED");

  if (paymentRequiredHeader != null && paymentRequiredHeader.length > 0) {
    return parsePaymentRequiredHeaderValue(paymentRequiredHeader, url);
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

function buildPaymentIdentifierExtension(
  extensions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(extensions)) {
    return undefined;
  }

  const paymentIdentifier = extensions["payment-identifier"];
  if (!isRecord(paymentIdentifier)) {
    return undefined;
  }

  const info = isRecord(paymentIdentifier.info) ? paymentIdentifier.info : {};
  if (typeof info.id === "string" && info.id.length > 0) {
    return {
      "payment-identifier": {
        info: {
          id: info.id,
        },
      },
    };
  }

  if (info.required !== true) {
    return undefined;
  }

  return {
    "payment-identifier": {
      info: {
        id: `pay_${randomUUID().replace(/-/g, "")}`,
      },
    },
  };
}

function getRequirementNetworkFamily(network: string): "solana" | "evm" | null {
  const normalized = normalizeNetworkId(network);
  if (normalized.startsWith("solana:")) return "solana";
  if (normalized.startsWith("eip155:")) return "evm";
  return null;
}

function getConfiguredPaymentNetwork(config: ResolvedConfig): string {
  if (config.payment.family === "solana") {
    return clusterToCAIP2(getSolanaCluster(config)).caip2;
  }

  return lookupX402Network(getEvmChainInfo(config).id);
}

function dedupePaymentOptions(
  options: PaymentRequirementDetails[],
): PaymentRequirementDetails[] {
  const seen = new Set<string>();
  const deduped: PaymentRequirementDetails[] = [];

  for (const option of options) {
    const key = `${option.network}:${option.asset.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }

  return deduped;
}

function dedupeExactPaymentRequirements(
  options: PaymentRequirementDetails[],
): PaymentRequirementDetails[] {
  const seen = new Set<string>();
  const deduped: PaymentRequirementDetails[] = [];

  for (const option of options) {
    const key = stableStringify(option.requirement);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }

  return deduped;
}

function formatAcceptedAssetOptions(
  options: PaymentRequirementDetails[],
): string {
  return dedupePaymentOptions(options)
    .map((option) =>
      option.symbol == null
        ? option.asset
        : `${option.symbol} (${option.asset})`,
    )
    .join(", ");
}

function formatAcceptedNetworkOptions(
  options: PaymentRequirementDetails[],
): string {
  const seen = new Set<string>();
  const networks: string[] = [];

  for (const option of options) {
    const display = formatPaymentOptionNetwork(option.network);
    if (seen.has(display)) {
      continue;
    }
    seen.add(display);
    networks.push(display);
  }

  return networks.join(", ");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value != null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function formatAmbiguousAssetOptions(
  matches: PaymentRequirementDetails[],
): string {
  const payTos = new Set(matches.map((match) => match.requirement.payTo));
  const timeouts = new Set(
    matches.map((match) => String(match.requirement.maxTimeoutSeconds)),
  );
  const extras = new Set(
    matches.map((match) => stableStringify(match.requirement.extra ?? null)),
  );

  return matches
    .map((match, index) => {
      const base =
        match.symbol == null ? match.asset : `${match.symbol} (${match.asset})`;
      const details: string[] = [];

      if (payTos.size > 1) {
        details.push(`payTo=${match.requirement.payTo}`);
      }
      if (timeouts.size > 1) {
        details.push(
          `maxTimeoutSeconds=${match.requirement.maxTimeoutSeconds}`,
        );
      }
      if (extras.size > 1) {
        details.push(
          `extra=${stableStringify(match.requirement.extra ?? null)}`,
        );
      }
      if (details.length === 0) {
        details.push(`requirement=${index + 1}`);
      }

      return `${base} [${details.join(", ")}]`;
    })
    .join(", ");
}

export function selectPaymentRequirement(args: {
  accepts: x402PaymentRequirementsV2[];
  config: ResolvedConfig;
}): PaymentRequirementSelection {
  const requestedAsset = args.config.payment.asset;
  const activeNetwork = getConfiguredPaymentNetwork(args.config);
  const options = getPaymentRequirementDetails(args.accepts);
  const activeNetworkOptions = dedupeExactPaymentRequirements(
    options.filter((option) => option.network === activeNetwork),
  );

  if (activeNetworkOptions.length === 0) {
    return {
      kind: "network-mismatch",
      activeNetwork,
      requestedAsset,
      options,
    };
  }

  const symbolMatches = activeNetworkOptions.filter(
    (option) => option.symbol?.toLowerCase() === requestedAsset.toLowerCase(),
  );

  if (symbolMatches.length === 1) {
    const selected = symbolMatches[0];
    if (selected == null) {
      throw new Error("expected exactly one selected payment requirement");
    }
    return {
      kind: "selected",
      activeNetwork,
      requestedAsset,
      selected,
    };
  }

  if (symbolMatches.length > 1) {
    return {
      kind: "asset-ambiguous",
      activeNetwork,
      requestedAsset,
      matches: symbolMatches,
    };
  }

  return {
    kind: "asset-mismatch",
    activeNetwork,
    requestedAsset,
    options: dedupePaymentOptions(activeNetworkOptions),
  };
}

export function formatPaymentRequirementMismatch(
  config: ResolvedConfig,
  selection: Exclude<PaymentRequirementSelection, { kind: "selected" }>,
): string {
  if (selection.kind === "asset-mismatch") {
    return `active payment network ${config.payment.network} does not offer asset ${selection.requestedAsset}; accepted assets: ${formatAcceptedAssetOptions(selection.options)}`;
  }

  if (selection.kind === "asset-ambiguous") {
    return `asset ${selection.requestedAsset} is ambiguous on active payment network ${config.payment.network}; matching requirements: ${formatAmbiguousAssetOptions(selection.matches)}`;
  }

  const acceptedNetworks = formatAcceptedNetworkOptions(selection.options);
  const acceptedFamilies = new Set(
    selection.options
      .map((option) => option.network)
      .map((network) => getRequirementNetworkFamily(network))
      .filter((family) => family != null),
  );

  if (
    acceptedFamilies.size === 1 &&
    acceptedFamilies.has("solana") &&
    config.payment.family !== "solana"
  ) {
    return `server only offered Solana x402 payment requirements (${acceptedNetworks}), but the active payment network is ${formatPaymentNetworkDisplay(config.payment.network)}; switch to a Solana network to call this endpoint`;
  }

  if (
    acceptedFamilies.size === 1 &&
    acceptedFamilies.has("evm") &&
    config.payment.family !== "evm"
  ) {
    return `server only offered EVM x402 payment requirements (${acceptedNetworks}), but the active payment network is ${formatPaymentNetworkDisplay(config.payment.network)}; switch to an EVM network to call this endpoint`;
  }

  return `server did not provide a supported x402 payment requirement for active payment network ${formatPaymentNetworkDisplay(config.payment.network)}; offered networks: ${acceptedNetworks}`;
}

function parseJSONText(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parsePaymentResponseHeaderValue(value: string): unknown {
  try {
    return parseJSONText(value);
  } catch {
    return parseJSONText(Buffer.from(value, "base64").toString("utf8"));
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
    build: async (config, requirement, deps) =>
      deps.buildOwsPaymentHandler(config, requirement),
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
  requirement: PaymentRequirementDetails | undefined,
  deps: BuildPaymentHandlerDeps,
): Promise<PaymentHandlerInfo> {
  for (const strategy of getPaymentHandlerStrategies()) {
    if (strategy.matches(config)) {
      return strategy.build(config, requirement, deps);
    }
  }

  throw new ConfigError(
    `unsupported active wallet family ${config.activeWallet.family}`,
  );
}

export function createBuildPaymentHandler(deps: BuildPaymentHandlerDeps) {
  return async function buildPaymentHandler(
    config: ResolvedConfig,
    requirement?: PaymentRequirementDetails,
  ): Promise<PaymentHandlerInfo> {
    return resolvePaymentHandler(config, requirement, deps);
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
    const selection = selectPaymentRequirement({
      accepts: paymentRequired.accepts,
      config: args.config,
    });
    if (selection.kind !== "selected") {
      throw new Error(formatPaymentRequirementMismatch(args.config, selection));
    }

    const { handler } = await deps.buildPaymentHandler(
      args.config,
      selection.selected,
    );
    const execers = await handler(
      { request: new Request(args.url, args.requestInit) },
      [selection.selected.requirement],
    );
    const execer = execers[0];
    if (execer == null) {
      throw new Error(
        `failed to build a payment retry for selected asset ${selection.requestedAsset} on ${args.config.payment.network}`,
      );
    }

    const { payload } = await execer.exec();
    const decimals = extractRequirementDecimals(execer.requirements);
    const extensions = buildPaymentIdentifierExtension(
      paymentRequired.extensions,
    );
    const header =
      paymentRequired.detectedVersion === 2
        ? {
            name: V2_PAYMENT_HEADER,
            value: Buffer.from(
              JSON.stringify({
                x402Version: 2,
                accepted: execer.requirements,
                payload,
                ...(extensions == null ? {} : { extensions }),
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
      detectedVersion: paymentRequired.detectedVersion,
      header,
      paymentInfo: {
        amount: execer.requirements.amount,
        asset: execer.requirements.asset,
        ...(selection.selected.symbol == null
          ? {}
          : { assetSymbol: selection.selected.symbol }),
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
  createConnection: (rpcURL) => new Connection(rpcURL, "confirmed"),
  lookupKnownSPLToken,
  clusterToCAIP2,
  lookupKnownAsset,
  lookupX402Network,
});

export const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
  buildPaymentHandler,
});
