import { command, option, optional, string, subcommands } from "cmd-ts";
import {
  printJson,
  printTable,
  printYaml,
  type OutputFormat,
  writeLine,
} from "../output/format.js";
import {
  ConfigError,
  type ConfigUpdateInput,
  type CorbitsConfig,
  buildInitialConfig,
  formatPaymentNetworkDisplay,
  getConfigPath,
  getWalletFamilyForNetwork,
  isPaymentNetwork,
  loadConfig,
  loadRequiredConfig,
  parsePaymentNetwork,
  printConfigView,
  printMissingConfig,
  resolveConfig,
  saveConfig,
  updateConfig,
} from "../config/index.js";
import { formatFlag, formatType, resolveOutputFormat } from "../flags.js";

type ConfigMutationArgs = {
  network: string | undefined;
  rpcUrl: string | undefined;
  solanaAddress: string | undefined;
  solanaPath: string | undefined;
  solanaOws: string | undefined;
  evmAddress: string | undefined;
  evmPath: string | undefined;
  evmOws: string | undefined;
  format: OutputFormat | undefined;
  apiUrl: string | undefined;
};

function stringMutationOption(long: string, description: string) {
  return option({
    type: optional(string),
    long,
    description,
  });
}

function printConfigMutationResult(
  format: OutputFormat,
  summary: string | undefined,
  rows: string[][],
  payload: unknown,
): void {
  if (format === "json") {
    printJson(payload);
    return;
  }

  if (format === "yaml") {
    printYaml(payload);
    return;
  }

  if (summary != null) {
    writeLine(summary);
  }
  if (rows.length > 0) {
    printTable(["Field", "Value"], rows);
  }
}

async function saveConfigAndPrintMutationResult(
  path: string,
  config: CorbitsConfig,
  summary: string | undefined,
  rows: string[][],
  payload: unknown,
): Promise<void> {
  await saveConfig(path, config);
  const format = await resolveOutputFormat(undefined, path);
  printConfigMutationResult(format, summary, rows, payload);
}

const configMutationArgs = {
  network: stringMutationOption("network", "Payment network"),
  rpcUrl: stringMutationOption(
    "rpc-url",
    "RPC URL override for the target network",
  ),
  solanaAddress: stringMutationOption(
    "solana-address",
    "Solana wallet address",
  ),
  solanaPath: stringMutationOption("solana-path", "Solana wallet path"),
  solanaOws: stringMutationOption("solana-ows", "Solana OWS wallet id"),
  evmAddress: stringMutationOption("evm-address", "EVM wallet address"),
  evmPath: stringMutationOption("evm-path", "EVM wallet path"),
  evmOws: stringMutationOption("evm-ows", "EVM OWS wallet id"),
  format: option({
    type: optional(formatType),
    long: "format",
    description: "Default output format",
  }),
  apiUrl: stringMutationOption("api-url", "Corbits API base URL"),
};

function formatMutationValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    if (isPaymentNetwork(value)) {
      return formatPaymentNetworkDisplay(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

function buildConfigMutationInput(args: ConfigMutationArgs): ConfigUpdateInput {
  return {
    ...(args.network == null ? {} : { network: args.network }),
    ...(args.rpcUrl == null ? {} : { rpcUrl: args.rpcUrl }),
    ...(args.solanaAddress == null
      ? {}
      : { solanaAddress: args.solanaAddress }),
    ...(args.solanaPath == null ? {} : { solanaPath: args.solanaPath }),
    ...(args.solanaOws == null ? {} : { solanaOws: args.solanaOws }),
    ...(args.evmAddress == null ? {} : { evmAddress: args.evmAddress }),
    ...(args.evmPath == null ? {} : { evmPath: args.evmPath }),
    ...(args.evmOws == null ? {} : { evmOws: args.evmOws }),
    ...(args.format == null ? {} : { format: args.format }),
    ...(args.apiUrl == null ? {} : { apiUrl: args.apiUrl }),
  };
}

function hasAnyMutation(input: ConfigUpdateInput): boolean {
  return Object.keys(input).length > 0;
}

function validateInitWalletRequirements(args: ConfigMutationArgs): void {
  const network = parsePaymentNetwork(
    args.network ?? "",
    "config init requires --network <name>",
  );
  const family = getWalletFamilyForNetwork(network);
  const address = family === "solana" ? args.solanaAddress : args.evmAddress;
  const keypairPath = family === "solana" ? args.solanaPath : args.evmPath;
  const owsWalletId = family === "solana" ? args.solanaOws : args.evmOws;

  if (address == null && keypairPath == null && owsWalletId == null) {
    throw new ConfigError(
      `config init requires --${family}-address <addr> plus one of --${family}-path <path> or --${family}-ows <wallet-id> when --network ${network} is selected`,
    );
  }
}

function shouldIncludeResolvedPayment(input: ConfigUpdateInput): boolean {
  return (
    input.network != null ||
    input.rpcUrl != null ||
    input.solanaAddress != null ||
    input.solanaPath != null ||
    input.solanaOws != null ||
    input.evmAddress != null ||
    input.evmPath != null ||
    input.evmOws != null
  );
}

type MutationEntry = { key: string; value: unknown };

function buildMutationEntries(
  config: CorbitsConfig,
  input: ConfigUpdateInput,
): MutationEntry[] {
  const resolved = resolveConfig(config);
  const entries: MutationEntry[] = [];

  if (input.network != null) {
    entries.push({ key: "payment_network", value: resolved.payment.network });
  }
  if (input.rpcUrl != null) {
    entries.push({ key: "payment_rpc_url_override", value: input.rpcUrl });
  }
  if (
    input.solanaAddress != null ||
    input.solanaPath != null ||
    input.solanaOws != null
  ) {
    entries.push({ key: "wallet_solana", value: config.wallets.solana });
  }
  if (
    input.evmAddress != null ||
    input.evmPath != null ||
    input.evmOws != null
  ) {
    entries.push({ key: "wallet_evm", value: config.wallets.evm });
  }
  if (input.format != null) {
    entries.push({ key: "format", value: config.preferences.format });
  }
  if (input.apiUrl != null) {
    entries.push({ key: "api_url", value: config.preferences.api_url });
  }
  if (shouldIncludeResolvedPayment(input)) {
    entries.push({ key: "payment_address", value: resolved.payment.address });
    entries.push({ key: "payment_asset", value: resolved.payment.asset });
    entries.push({ key: "payment_rpc_url", value: resolved.payment.rpcUrl });
  }

  return entries;
}

function buildMutationRows(entries: MutationEntry[]): string[][] {
  return entries.map(({ key, value }) => [key, formatMutationValue(value)]);
}

function buildMutationPayload(
  entries: MutationEntry[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = { status: "ok", action: "set" };
  for (const { key, value } of entries) {
    payload[key] = value;
  }
  return payload;
}

const configPathFlag = option({
  type: optional(string),
  long: "config",
  description:
    "Path to the config file (default: ~/.config/corbits/config.toml)",
});

export const configShow = command({
  name: "show",
  description: "Show the current config state",
  args: {
    format: formatFlag,
    config: configPathFlag,
  },
  handler: async ({ format: formatArg, config: configPath }) => {
    const format = await resolveOutputFormat(formatArg, configPath);
    const loaded = await loadConfig(configPath);
    if (loaded == null) {
      printMissingConfig(getConfigPath(configPath), format);
      return;
    }

    printConfigView(loaded, format);
  },
});

export const configInit = command({
  name: "init",
  description: "Create the initial Corbits config file",
  args: {
    ...configMutationArgs,
    config: configPathFlag,
  },
  handler: async (args) => {
    const configPath = getConfigPath(args.config);
    const existing = await loadConfig(args.config);
    if (existing != null) {
      const format = await resolveOutputFormat(args.format, args.config);
      printConfigMutationResult(
        format,
        "config: already initialized (no-op)",
        [
          ["path", existing.path],
          ["payment_network", existing.resolved.payment.network],
        ],
        {
          status: "noop",
          action: "init",
          path: existing.path,
          payment_network: existing.resolved.payment.network,
        },
      );
      return;
    }

    validateInitWalletRequirements(args);

    const config = buildInitialConfig({
      network: args.network ?? "",
      ...(args.rpcUrl == null ? {} : { rpcUrl: args.rpcUrl }),
      ...(args.format == null ? {} : { format: args.format }),
      ...(args.apiUrl == null ? {} : { apiUrl: args.apiUrl }),
      ...(args.solanaAddress == null
        ? {}
        : { solanaAddress: args.solanaAddress }),
      ...(args.solanaPath == null ? {} : { solanaPath: args.solanaPath }),
      ...(args.solanaOws == null ? {} : { solanaOws: args.solanaOws }),
      ...(args.evmAddress == null ? {} : { evmAddress: args.evmAddress }),
      ...(args.evmPath == null ? {} : { evmPath: args.evmPath }),
      ...(args.evmOws == null ? {} : { evmOws: args.evmOws }),
    });

    const resolved = resolveConfig(config);
    await saveConfigAndPrintMutationResult(
      configPath,
      config,
      "config: initialized",
      [
        ["path", configPath],
        ["payment_network", config.payment.network],
        ["payment_address", resolved.payment.address],
        ...(args.rpcUrl == null
          ? []
          : [["payment_rpc_url_override", args.rpcUrl]]),
      ],
      {
        status: "ok",
        action: "init",
        path: configPath,
        payment_network: config.payment.network,
        payment_address: resolved.payment.address,
        ...(args.rpcUrl == null
          ? {}
          : { payment_rpc_url_override: args.rpcUrl }),
      },
    );
  },
});

export const configSet = command({
  name: "set",
  description: "Update config values",
  args: {
    ...configMutationArgs,
    config: configPathFlag,
  },
  handler: async (args) => {
    const updates = buildConfigMutationInput(args);

    if (!hasAnyMutation(updates)) {
      throw new Error("config set requires at least one flag");
    }

    const loaded = await loadRequiredConfig(args.config);
    const config = updateConfig(loaded.config, updates);
    const entries = buildMutationEntries(config, updates);
    await saveConfigAndPrintMutationResult(
      loaded.path,
      config,
      undefined,
      buildMutationRows(entries),
      buildMutationPayload(entries),
    );
  },
});

export const config = subcommands({
  name: "config",
  description: "Inspect and manage Corbits config",
  cmds: {
    show: configShow,
    init: configInit,
    set: configSet,
  },
});
