import { parse, stringify } from "smol-toml";
import os from "node:os";
import path from "node:path";
import { type } from "arktype";
import {
  normalizeNetworkId,
  solana,
  translateNetworkToLegacy,
} from "@faremeter/info";

// CLI-supported payment networks (single source of truth)
const PAYMENT_NETWORKS = [
  "devnet",
  "mainnet-beta",
  "localnet",
  "base",
  "base-sepolia",
] as const;
export type PaymentNetwork = (typeof PAYMENT_NETWORKS)[number];
const PaymentNetworkSchema = type.enumerated(...PAYMENT_NETWORKS);
const PAYMENT_NETWORK_DISPLAY_NAMES: Record<PaymentNetwork, string> = {
  devnet: "solana-devnet",
  "mainnet-beta": "solana-mainnet-beta",
  localnet: "solana-localnet",
  base: "base",
  "base-sepolia": "base-sepolia",
};

const OutputFormatSchema = type("'table' | 'json' | 'yaml'");
export type OutputFormat = typeof OutputFormatSchema.infer;

export type WalletFamily = "solana" | "evm";

const KeypairWalletConfigSchema = type({
  "+": "reject",
  address: "string > 0",
  kind: "'keypair'",
  path: "string > 0",
});
export type KeypairWalletConfig = typeof KeypairWalletConfigSchema.infer;

const OwsWalletConfigSchema = type({
  "+": "reject",
  address: "string > 0",
  kind: "'ows'",
  wallet_id: "string > 0",
});
export type OwsWalletConfig = typeof OwsWalletConfigSchema.infer;

const WalletConfigSchema = KeypairWalletConfigSchema.or(OwsWalletConfigSchema);
export type WalletConfig = typeof WalletConfigSchema.infer;

const PreferencesSchema = type({
  "+": "reject",
  format: OutputFormatSchema,
  api_url: "string",
});

const PaymentSectionSchema = type({
  "+": "reject",
  network: "string",
  "rpc_url_overrides?": "object",
});

const WalletsSectionSchema = type({
  "+": "reject",
  "solana?": "object",
  "evm?": "object",
});

const ConfigFileSchema = type({
  "+": "reject",
  version: "1",
  preferences: PreferencesSchema,
  payment: PaymentSectionSchema,
  wallets: WalletsSectionSchema,
});

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

export const DEFAULT_API_URL = "https://api.corbits.dev";

const DEFAULT_RPC_URLS: Record<PaymentNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
  base: "https://mainnet.base.org",
  "base-sepolia": "https://sepolia.base.org",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function listPaymentNetworks(): readonly PaymentNetwork[] {
  return PAYMENT_NETWORKS;
}

export function formatPaymentNetworkDisplay(network: PaymentNetwork): string {
  return PAYMENT_NETWORK_DISPLAY_NAMES[network];
}

export function formatSupportedPaymentNetworks(): string {
  return PAYMENT_NETWORKS.map(formatPaymentNetworkDisplay).join(", ");
}

export function isPaymentNetwork(value: string): value is PaymentNetwork {
  return !(PaymentNetworkSchema(value) instanceof type.errors);
}

export function getWalletFamilyForNetwork(
  network: PaymentNetwork,
): WalletFamily {
  if (network === "localnet" || solana.isKnownCluster(network)) {
    return "solana";
  }
  return "evm";
}

export function getPaymentNetworkDefaults(network: PaymentNetwork): {
  asset: string;
  rpcUrl: string;
} {
  return { asset: "USDC", rpcUrl: DEFAULT_RPC_URLS[network] };
}

function normalizeToPaymentNetwork(input: string): PaymentNetwork | null {
  // Direct match
  if (isPaymentNetwork(input)) return input;
  // Solana shorthand: "solana" → mainnet-beta
  if (input === "solana" || input === "solana-mainnet") return "mainnet-beta";
  if (input === "solana-devnet") return "devnet";
  if (input === "solana-localnet") return "localnet";
  // Try CAIP-2 normalization for EVM networks
  const caip2 = normalizeNetworkId(input);
  const legacy = translateNetworkToLegacy(caip2);
  return isPaymentNetwork(legacy) ? legacy : null;
}

export function requireConfigString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(message);
  }
  return value.trim();
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
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
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
  if (overrides == null) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)),
  ) as RpcUrlOverrides;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseRpcUrlOverrides(value: unknown): RpcUrlOverrides | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Config payment.rpc_url_overrides must be a table");
  }
  const record = value as Record<string, unknown>;
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

function parseWalletConfig(
  value: unknown,
  family: WalletFamily,
): WalletConfig | undefined {
  if (value == null) return undefined;
  const result = WalletConfigSchema(value);
  if (result instanceof type.errors) {
    throw new ConfigError(formatWalletError(result, family));
  }
  return result;
}

function formatWalletError(
  errors: InstanceType<typeof type.errors>,
  family: WalletFamily,
): string {
  const error = errors[0];
  if (error == null) throw new Error("arktype returned empty error collection");
  const [key] = Array.from(error.path, String);
  if (
    error.code === "predicate" &&
    "expected" in error &&
    error.expected === "removed"
  ) {
    const record =
      typeof error.data === "object" && error.data !== null
        ? (error.data as Record<string, unknown>)
        : {};
    if (record.kind === "keypair" && key === "wallet_id") {
      return `Config wallets.${family}: wallet_id is not allowed when kind is "keypair"`;
    }
    if (record.kind === "ows" && key === "path") {
      return `Config wallets.${family}: path must be removed when kind is "ows"`;
    }
    return `Unknown wallets.${family} key "${key}"`;
  }
  return `Config wallets.${family}: ${errors.summary}`;
}

function formatConfigError(errors: InstanceType<typeof type.errors>): string {
  const error = errors[0];
  if (error == null) throw new Error("arktype returned empty error collection");
  const path = Array.from(error.path, String);
  const joinedPath = path.join(".");
  if (
    error.code === "predicate" &&
    "expected" in error &&
    error.expected === "removed"
  ) {
    if (path.length === 1) return `Unknown config key "${path[0]}"`;
    if (path.length === 2) return `Unknown ${path[0]} key "${path[1]}"`;
  }
  if (joinedPath === "version") return "Config version must be 1";
  if (joinedPath === "preferences")
    return "Config preferences section is required";
  if (joinedPath === "payment") return "Config payment section is required";
  if (joinedPath === "wallets") return "Config wallets section is required";
  if (joinedPath === "preferences.format")
    return 'Config preferences.format must be "table", "json", or "yaml"';
  return `Invalid config: ${errors.summary}`;
}

function requireWalletForFamily(
  wallets: WalletRegistry,
  family: WalletFamily,
  network: PaymentNetwork,
): WalletConfig {
  const wallet = wallets[family];
  if (wallet == null) {
    throw new ConfigError(
      `Config wallets.${family} is required for payment.network "${network}"`,
    );
  }
  return wallet;
}

function buildWalletConfigFromInput(
  family: WalletFamily,
  address: string | undefined,
  keypairPath: string | undefined,
  owsId: string | undefined,
): WalletConfig {
  if (keypairPath != null && owsId != null) {
    throw new ConfigError(
      `config ${family} wallet must provide only one of --${family}-path or --${family}-ows`,
    );
  }
  const addr = requireConfigString(
    address,
    `config ${family} wallet requires --${family}-address <addr>`,
  );
  if (keypairPath != null) return buildKeypairWalletConfig(addr, keypairPath);
  if (owsId != null) return buildOwsWalletConfig(addr, owsId);
  throw new ConfigError(
    `config ${family} wallet requires one of --${family}-path or --${family}-ows`,
  );
}

function hasWalletInput(
  address: string | undefined,
  keypair: string | undefined,
  ows: string | undefined,
): boolean {
  return address != null || keypair != null || ows != null;
}

function buildWalletRegistry(input: WalletInputs): WalletRegistry {
  const wallets: WalletRegistry = {};
  if (hasWalletInput(input.solanaAddress, input.solanaPath, input.solanaOws)) {
    wallets.solana = buildWalletConfigFromInput(
      "solana",
      input.solanaAddress,
      input.solanaPath,
      input.solanaOws,
    );
  }
  if (hasWalletInput(input.evmAddress, input.evmPath, input.evmOws)) {
    wallets.evm = buildWalletConfigFromInput(
      "evm",
      input.evmAddress,
      input.evmPath,
      input.evmOws,
    );
  }
  return wallets;
}

function mergeWalletUpdate(
  family: WalletFamily,
  current: WalletConfig | undefined,
  address: string | undefined,
  keypair: string | undefined,
  ows: string | undefined,
): WalletConfig | undefined {
  if (!hasWalletInput(address, keypair, ows)) return current;
  if (keypair != null || ows != null) {
    return buildWalletConfigFromInput(family, address, keypair, ows);
  }
  if (address == null) return current;
  if (current == null) {
    throw new ConfigError(
      `config ${family} wallet requires one of --${family}-path or --${family}-ows before --${family}-address can be used`,
    );
  }
  return current.kind === "keypair"
    ? buildKeypairWalletConfig(address, current.path)
    : buildOwsWalletConfig(address, current.wallet_id);
}

function mergeWalletRegistry(
  current: WalletRegistry,
  input: WalletInputs,
): WalletRegistry {
  const solana = mergeWalletUpdate(
    "solana",
    current.solana,
    input.solanaAddress,
    input.solanaPath,
    input.solanaOws,
  );
  const evm = mergeWalletUpdate(
    "evm",
    current.evm,
    input.evmAddress,
    input.evmPath,
    input.evmOws,
  );
  return normalizeWalletRegistry({
    ...(solana == null ? {} : { solana }),
    ...(evm == null ? {} : { evm }),
  });
}

function normalizeWalletConfig(wallet: WalletConfig): WalletConfig {
  return wallet.kind === "keypair"
    ? { address: wallet.address, kind: "keypair", path: wallet.path }
    : { address: wallet.address, kind: "ows", wallet_id: wallet.wallet_id };
}

function normalizeWalletRegistry(wallets: WalletRegistry): WalletRegistry {
  const normalized: WalletRegistry = {};
  if (wallets.solana != null)
    normalized.solana = normalizeWalletConfig(wallets.solana);
  if (wallets.evm != null) normalized.evm = normalizeWalletConfig(wallets.evm);
  return normalized;
}

export function buildInitialConfig(input: ConfigInitInput): CorbitsConfig {
  const network = parsePaymentNetwork(
    input.network,
    "config init requires --network <name>",
  );
  const wallets = buildWalletRegistry(input);
  requireWalletForFamily(wallets, getWalletFamilyForNetwork(network), network);
  const rpcOverride =
    input.rpcUrl == null
      ? undefined
      : {
          [network]: validateAbsoluteUrl(
            requireConfigString(
              input.rpcUrl,
              "config requires --rpc-url <url>",
            ),
            `payment.rpc_url_overrides.${network}`,
          ),
        };
  return normalizeConfig({
    version: 1,
    preferences: {
      format: input.format ?? "table",
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
      ...(rpcOverride == null ? {} : { rpc_url_overrides: rpcOverride }),
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
  const rpcOverride =
    input.rpcUrl == null
      ? config.payment.rpc_url_overrides
      : normalizeRpcUrlOverrides({
          ...(config.payment.rpc_url_overrides ?? {}),
          [targetNetwork]: validateAbsoluteUrl(
            requireConfigString(
              input.rpcUrl,
              "config requires --rpc-url <url>",
            ),
            `payment.rpc_url_overrides.${targetNetwork}`,
          ),
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
      ...(rpcOverride == null ? {} : { rpc_url_overrides: rpcOverride }),
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("Config must be a TOML table");
  }
  const result = ConfigFileSchema(raw);
  if (result instanceof type.errors) {
    throw new ConfigError(formatConfigError(result));
  }
  const config = result;
  const network = parsePaymentNetwork(
    typeof config.payment.network === "string" ? config.payment.network : "",
    `Config payment.network must be one of: ${formatSupportedPaymentNetworks()}`,
  );
  const solanaWallet = parseWalletConfig(config.wallets.solana, "solana");
  const evmWallet = parseWalletConfig(config.wallets.evm, "evm");
  const rpcUrlOverrides = parseRpcUrlOverrides(
    config.payment.rpc_url_overrides,
  );
  const parsed: CorbitsConfig = {
    version: config.version,
    preferences: {
      format: config.preferences.format,
      api_url: validateAbsoluteUrl(
        requireConfigString(
          config.preferences.api_url,
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
