import { parse, stringify } from "smol-toml";
import os from "node:os";
import path from "node:path";
import { solana, evm, normalizeNetworkId } from "@faremeter/info";
import type { OutputFormat } from "../output/format.js";

export const PAYMENT_NETWORKS = [
  "devnet",
  "mainnet-beta",
  "localnet",
  "base",
  "base-sepolia",
] as const;

export type PaymentNetwork = (typeof PAYMENT_NETWORKS)[number];
export type WalletFamily = "solana" | "evm";

export type KeypairWalletConfig = {
  address: string;
  kind: "keypair";
  path: string;
};

export type OwsWalletConfig = {
  address: string;
  kind: "ows";
  wallet_id: string;
};

export type WalletConfig = KeypairWalletConfig | OwsWalletConfig;

export type WalletRegistry = {
  solana?: WalletConfig;
  evm?: WalletConfig;
};

export type RpcUrlOverrides = Partial<Record<PaymentNetwork, string>>;

export type CorbitsConfig = {
  version: 1;
  preferences: {
    format: OutputFormat;
    api_url: string;
  };
  payment: {
    network: PaymentNetwork;
    rpc_url_overrides?: RpcUrlOverrides;
  };
  wallets: WalletRegistry;
};

export type ResolvedKeypairWallet = {
  address: string;
  family: WalletFamily;
  kind: "keypair";
  path: string;
  expandedPath: string;
};

export type ResolvedOwsWallet = {
  address: string;
  family: WalletFamily;
  kind: "ows";
  walletId: string;
};

export type ResolvedWallet = ResolvedKeypairWallet | ResolvedOwsWallet;

export type ResolvedConfig = {
  version: 1;
  preferences: {
    format: OutputFormat;
    apiUrl: string;
  };
  payment: {
    network: PaymentNetwork;
    family: WalletFamily;
    address: string;
    asset: string;
    rpcUrl: string;
  };
  activeWallet: ResolvedWallet;
};

type ConfigRecord = Record<string, unknown>;

type WalletInputs = {
  solanaPath?: string;
  solanaOws?: string;
  solanaAddress?: string;
  evmPath?: string;
  evmOws?: string;
  evmAddress?: string;
};

type ConfigInitInput = {
  network: string;
  rpcUrl?: string;
  format?: OutputFormat;
  apiUrl?: string;
} & WalletInputs;

export type ConfigUpdateInput = {
  network?: string;
  rpcUrl?: string;
  format?: OutputFormat;
  apiUrl?: string;
} & WalletInputs;

type WalletUpdateInput = {
  address?: string;
  keypair?: string;
  ows?: string;
};

export const DEFAULT_API_URL = "https://api.corbits.dev";
const DEFAULT_OUTPUT_FORMAT: OutputFormat = "table";

const DEFAULT_RPC_URLS: Record<PaymentNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

const CAIP2_TO_NETWORK: Record<string, PaymentNetwork> = {
  [solana.SOLANA_DEVNET.caip2]: "devnet",
  [solana.SOLANA_MAINNET_BETA.caip2]: "mainnet-beta",
  [evm.chainIdToCAIP2(8453)]: "base",
  [evm.chainIdToCAIP2(84532)]: "base-sepolia",
};

function normalizeToPaymentNetwork(input: string): PaymentNetwork | null {
  if (PAYMENT_NETWORKS.includes(input as PaymentNetwork)) {
    return input as PaymentNetwork;
  }

  if (input === "localnet" || input === "solana-localnet") {
    return "localnet";
  }

  const caip2 = normalizeNetworkId(input);
  return CAIP2_TO_NETWORK[caip2] ?? null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function requireConfigString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(message);
  }

  return value.trim();
}

export function listPaymentNetworks(): readonly PaymentNetwork[] {
  return PAYMENT_NETWORKS;
}

export function formatSupportedPaymentNetworks(): string {
  return PAYMENT_NETWORKS.join(", ");
}

export function isPaymentNetwork(value: string): value is PaymentNetwork {
  return PAYMENT_NETWORKS.includes(value as PaymentNetwork);
}

export function getWalletFamilyForNetwork(
  network: PaymentNetwork,
): WalletFamily {
  if (solana.isKnownCluster(network) || network === "localnet") {
    return "solana";
  }
  return "evm";
}

export function getPaymentNetworkDefaults(network: PaymentNetwork): {
  asset: string;
  rpcUrl: string;
} {
  return {
    asset: "USDC",
    rpcUrl: DEFAULT_RPC_URLS[network],
  };
}

export function parsePaymentNetwork(
  value: string,
  message = "config requires --network <name>",
): PaymentNetwork {
  const input = requireConfigString(value, message);
  const network = normalizeToPaymentNetwork(input);
  if (network != null) {
    return network;
  }

  throw new ConfigError(
    `Invalid payment network "${input}". Must be one of: ${formatSupportedPaymentNetworks()}`,
  );
}

export function buildKeypairWalletConfig(
  address: string,
  pathValue: string,
): KeypairWalletConfig {
  return {
    address: requireConfigString(address, "config requires a wallet address"),
    kind: "keypair",
    path: requireConfigString(pathValue, "config requires a wallet path"),
  };
}

export function buildOwsWalletConfig(
  address: string,
  walletId: string,
): OwsWalletConfig {
  return {
    address: requireConfigString(address, "config requires a wallet address"),
    kind: "ows",
    wallet_id: requireConfigString(walletId, "config requires a wallet id"),
  };
}

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isConfigRecord(value: unknown): value is ConfigRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, message: string): ConfigRecord {
  if (!isConfigRecord(value)) {
    throw new ConfigError(message);
  }

  return value;
}

function assertAllowedKeys(
  value: ConfigRecord,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`Unknown ${context} key "${key}"`);
    }
  }
}

function readOutputFormat(value: unknown): OutputFormat {
  if (value === "table" || value === "json" || value === "yaml") {
    return value;
  }

  throw new ConfigError(
    'Config preferences.format must be "table", "json", or "yaml"',
  );
}

function readVersion(value: unknown): 1 {
  if (value !== 1) {
    throw new ConfigError("Config version must be 1");
  }

  return 1;
}

function validateAbsoluteUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Invalid ${field} "${value}"`);
  }

  if (
    parsed.host.length === 0 ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    throw new ConfigError(`Invalid ${field} "${value}"`);
  }

  return value;
}

function normalizeRpcUrlOverrides(
  overrides: RpcUrlOverrides | undefined,
): RpcUrlOverrides | undefined {
  if (overrides == null) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(overrides).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as RpcUrlOverrides;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseRpcUrlOverrides(value: unknown): RpcUrlOverrides | undefined {
  if (value == null) {
    return undefined;
  }

  const record = readRecord(
    value,
    "Config payment.rpc_url_overrides must be a table",
  );
  const overrides: RpcUrlOverrides = {};

  for (const [key, rpcUrl] of Object.entries(record)) {
    const network = normalizeToPaymentNetwork(key);
    if (network == null) {
      throw new ConfigError(
        `Config payment.rpc_url_overrides key "${key}" must be one of: ${formatSupportedPaymentNetworks()}`,
      );
    }

    overrides[network] = validateAbsoluteUrl(
      requireConfigString(
        rpcUrl,
        `Config payment.rpc_url_overrides.${network} must be a non-empty URL`,
      ),
      `payment.rpc_url_overrides.${network}`,
    );
  }

  return normalizeRpcUrlOverrides(overrides);
}

function buildRpcUrlOverrideUpdate(
  network: PaymentNetwork,
  rpcUrl: string,
): RpcUrlOverrides {
  return {
    [network]: validateAbsoluteUrl(
      requireConfigString(rpcUrl, "config requires --rpc-url <url>"),
      `payment.rpc_url_overrides.${network}`,
    ),
  };
}

function parseWalletConfig(
  value: unknown,
  family: WalletFamily,
): WalletConfig | undefined {
  if (value == null) {
    return undefined;
  }

  const context = `wallets.${family}`;
  const wallet = readRecord(value, `Config ${context} must be a table`);
  assertAllowedKeys(wallet, ["address", "kind", "path", "wallet_id"], context);

  const address = requireConfigString(
    wallet.address,
    `Config ${context}.address must be a non-empty string`,
  );

  if (wallet.kind === "keypair") {
    if (wallet.wallet_id != null) {
      throw new ConfigError(
        `Config ${context}.wallet_id is not allowed when kind is "keypair"`,
      );
    }

    return {
      address,
      kind: "keypair",
      path: requireConfigString(
        wallet.path,
        `Config ${context}.path must be non-empty when kind is "keypair"`,
      ),
    };
  }

  if (wallet.kind === "ows") {
    if (wallet.path != null) {
      throw new ConfigError(
        `Config ${context}.path is not allowed when kind is "ows"`,
      );
    }

    return {
      address,
      kind: "ows",
      wallet_id: requireConfigString(
        wallet.wallet_id,
        `Config ${context}.wallet_id must be non-empty when kind is "ows"`,
      ),
    };
  }

  throw new ConfigError(`Config ${context}.kind must be "keypair" or "ows"`);
}

function normalizeWalletConfig(wallet: WalletConfig): WalletConfig {
  if (wallet.kind === "keypair") {
    return {
      address: wallet.address,
      kind: "keypair",
      path: wallet.path,
    };
  }

  return {
    address: wallet.address,
    kind: "ows",
    wallet_id: wallet.wallet_id,
  };
}

function normalizeWalletRegistry(wallets: WalletRegistry): WalletRegistry {
  const normalized: WalletRegistry = {};

  if (wallets.solana != null) {
    normalized.solana = normalizeWalletConfig(wallets.solana);
  }
  if (wallets.evm != null) {
    normalized.evm = normalizeWalletConfig(wallets.evm);
  }

  return normalized;
}

function requireWalletForFamily(
  wallets: WalletRegistry,
  family: WalletFamily,
  paymentNetwork: PaymentNetwork,
): WalletConfig {
  const wallet = wallets[family];
  if (wallet == null) {
    throw new ConfigError(
      `Config wallets.${family} is required for payment.network "${paymentNetwork}"`,
    );
  }

  return wallet;
}

function hasWalletUpdate(input: WalletUpdateInput): boolean {
  return input.address != null || input.keypair != null || input.ows != null;
}

function buildWalletUpdateInput(
  address: string | undefined,
  keypair: string | undefined,
  ows: string | undefined,
): WalletUpdateInput {
  return {
    ...(address == null ? {} : { address }),
    ...(keypair == null ? {} : { keypair }),
    ...(ows == null ? {} : { ows }),
  };
}

function buildWalletConfigFromInput(
  family: WalletFamily,
  input: WalletUpdateInput,
): WalletConfig {
  if (input.keypair != null && input.ows != null) {
    throw new ConfigError(
      `config ${family} wallet must provide only one of --${family}-path or --${family}-ows`,
    );
  }

  const address = requireConfigString(
    input.address,
    `config ${family} wallet requires --${family}-address <addr>`,
  );

  if (input.keypair != null) {
    return buildKeypairWalletConfig(address, input.keypair);
  }

  if (input.ows != null) {
    return buildOwsWalletConfig(address, input.ows);
  }

  throw new ConfigError(
    `config ${family} wallet requires one of --${family}-path or --${family}-ows`,
  );
}

function buildWalletRegistry(input: WalletInputs): WalletRegistry {
  const wallets: WalletRegistry = {};
  const solanaInput = buildWalletUpdateInput(
    input.solanaAddress,
    input.solanaPath,
    input.solanaOws,
  );
  const evmInput = buildWalletUpdateInput(
    input.evmAddress,
    input.evmPath,
    input.evmOws,
  );

  if (hasWalletUpdate(solanaInput)) {
    wallets.solana = buildWalletConfigFromInput("solana", solanaInput);
  }
  if (hasWalletUpdate(evmInput)) {
    wallets.evm = buildWalletConfigFromInput("evm", evmInput);
  }

  return wallets;
}

function mergeWalletUpdate(
  family: WalletFamily,
  current: WalletConfig | undefined,
  input: WalletUpdateInput,
): WalletConfig | undefined {
  if (!hasWalletUpdate(input)) {
    return current;
  }

  if (input.keypair != null || input.ows != null) {
    return buildWalletConfigFromInput(family, input);
  }

  if (input.address == null) {
    return current;
  }

  if (current == null) {
    throw new ConfigError(
      `config ${family} wallet requires one of --${family}-path or --${family}-ows before --${family}-address can be used`,
    );
  }

  if (current.kind === "keypair") {
    return buildKeypairWalletConfig(input.address, current.path);
  }

  return buildOwsWalletConfig(input.address, current.wallet_id);
}

function mergeWalletRegistry(
  current: WalletRegistry,
  input: WalletInputs,
): WalletRegistry {
  const solana = mergeWalletUpdate(
    "solana",
    current.solana,
    buildWalletUpdateInput(
      input.solanaAddress,
      input.solanaPath,
      input.solanaOws,
    ),
  );
  const evm = mergeWalletUpdate(
    "evm",
    current.evm,
    buildWalletUpdateInput(input.evmAddress, input.evmPath, input.evmOws),
  );

  return normalizeWalletRegistry({
    ...(solana == null ? {} : { solana }),
    ...(evm == null ? {} : { evm }),
  });
}

export function buildInitialConfig(input: ConfigInitInput): CorbitsConfig {
  const network = parsePaymentNetwork(
    input.network,
    "config init requires --network <name>",
  );
  const wallets = buildWalletRegistry(input);

  requireWalletForFamily(wallets, getWalletFamilyForNetwork(network), network);

  return normalizeConfig({
    version: 1,
    preferences: {
      format: input.format ?? DEFAULT_OUTPUT_FORMAT,
      api_url: validateAbsoluteUrl(
        requireConfigString(
          input.apiUrl ?? DEFAULT_API_URL,
          "config init requires --api-url <url>",
        ),
        "preferences.api_url",
      ),
    },
    payment: {
      network,
      ...(input.rpcUrl == null
        ? {}
        : {
            rpc_url_overrides: buildRpcUrlOverrideUpdate(network, input.rpcUrl),
          }),
    },
    wallets,
  });
}

export function updateConfig(
  config: CorbitsConfig,
  input: ConfigUpdateInput,
): CorbitsConfig {
  const targetNetwork =
    input.network == null
      ? config.payment.network
      : parsePaymentNetwork(
          input.network,
          "config set requires --network <name>",
        );
  const nextRpcUrlOverrides =
    input.rpcUrl == null
      ? config.payment.rpc_url_overrides
      : normalizeRpcUrlOverrides({
          ...(config.payment.rpc_url_overrides ?? {}),
          ...buildRpcUrlOverrideUpdate(targetNetwork, input.rpcUrl),
        });
  const next: CorbitsConfig = {
    version: 1,
    preferences: {
      format: input.format ?? config.preferences.format,
      api_url:
        input.apiUrl == null
          ? config.preferences.api_url
          : validateAbsoluteUrl(
              requireConfigString(
                input.apiUrl,
                "config set requires --api-url <url>",
              ),
              "preferences.api_url",
            ),
    },
    payment: {
      network: targetNetwork,
      ...(nextRpcUrlOverrides == null
        ? {}
        : { rpc_url_overrides: nextRpcUrlOverrides }),
    },
    wallets: mergeWalletRegistry(config.wallets, input),
  };

  requireWalletForFamily(
    next.wallets,
    getWalletFamilyForNetwork(next.payment.network),
    next.payment.network,
  );

  return normalizeConfig(next);
}

export function parseConfig(text: string): CorbitsConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(
      `Invalid config TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const config = readRecord(raw, "Config must be a TOML table");
  assertAllowedKeys(
    config,
    ["version", "preferences", "payment", "wallets"],
    "config",
  );

  const version = readVersion(config.version);

  const preferences = readRecord(
    config.preferences,
    "Config preferences section is required",
  );
  assertAllowedKeys(preferences, ["format", "api_url"], "preferences");

  const payment = readRecord(
    config.payment,
    "Config payment section is required",
  );
  assertAllowedKeys(payment, ["network", "rpc_url_overrides"], "payment");

  const wallets = readRecord(
    config.wallets,
    "Config wallets section is required",
  );
  assertAllowedKeys(wallets, ["solana", "evm"], "wallets");

  const solanaWallet = parseWalletConfig(wallets.solana, "solana");
  const evmWallet = parseWalletConfig(wallets.evm, "evm");
  const rpcUrlOverrides = parseRpcUrlOverrides(payment.rpc_url_overrides);

  if (typeof payment.network !== "string") {
    throw new ConfigError(
      `Config payment.network must be one of: ${formatSupportedPaymentNetworks()}`,
    );
  }
  const network = parsePaymentNetwork(
    payment.network,
    `Config payment.network must be one of: ${formatSupportedPaymentNetworks()}`,
  );

  const parsed: CorbitsConfig = {
    version,
    preferences: {
      format: readOutputFormat(preferences.format),
      api_url: validateAbsoluteUrl(
        requireConfigString(
          preferences.api_url,
          "Config preferences.api_url must be a non-empty URL",
        ),
        "preferences.api_url",
      ),
    },
    payment: {
      network,
      ...(rpcUrlOverrides == null
        ? {}
        : { rpc_url_overrides: rpcUrlOverrides }),
    },
    wallets: normalizeWalletRegistry({
      ...(solanaWallet == null ? {} : { solana: solanaWallet }),
      ...(evmWallet == null ? {} : { evm: evmWallet }),
    }),
  };

  requireWalletForFamily(
    parsed.wallets,
    getWalletFamilyForNetwork(parsed.payment.network),
    parsed.payment.network,
  );

  return parsed;
}

export function normalizeConfig(config: CorbitsConfig): CorbitsConfig {
  const rpcUrlOverrides = normalizeRpcUrlOverrides(
    config.payment.rpc_url_overrides,
  );

  return {
    version: 1,
    preferences: {
      format: config.preferences.format,
      api_url: config.preferences.api_url,
    },
    payment: {
      network: config.payment.network,
      ...(rpcUrlOverrides == null
        ? {}
        : { rpc_url_overrides: rpcUrlOverrides }),
    },
    wallets: normalizeWalletRegistry(config.wallets),
  };
}

export function stringifyConfig(config: CorbitsConfig): string {
  return stringify(normalizeConfig(config));
}

function resolveActiveWallet(
  wallets: WalletRegistry,
  network: PaymentNetwork,
): ResolvedWallet {
  const family = getWalletFamilyForNetwork(network);
  const wallet = requireWalletForFamily(wallets, family, network);

  if (wallet.kind === "keypair") {
    return {
      address: wallet.address,
      family,
      kind: "keypair",
      path: wallet.path,
      expandedPath: expandHome(wallet.path),
    };
  }

  return {
    address: wallet.address,
    family,
    kind: "ows",
    walletId: wallet.wallet_id,
  };
}

export function resolveConfig(config: CorbitsConfig): ResolvedConfig {
  const activeWallet = resolveActiveWallet(
    config.wallets,
    config.payment.network,
  );
  const defaults = getPaymentNetworkDefaults(config.payment.network);
  const rpcUrl =
    config.payment.rpc_url_overrides?.[config.payment.network] ??
    defaults.rpcUrl;

  return {
    version: config.version,
    preferences: {
      format: config.preferences.format,
      apiUrl: config.preferences.api_url,
    },
    payment: {
      network: config.payment.network,
      family: getWalletFamilyForNetwork(config.payment.network),
      address: activeWallet.address,
      asset: defaults.asset,
      rpcUrl,
    },
    activeWallet,
  };
}
