import { parse, stringify } from "smol-toml";
import type { OutputFormat } from "../output/format.js";
import { expandHome } from "./path.js";

export type NetworkConfig = {
  address: string;
  keyfile: string;
};

export type CorbitsConfig = {
  version: 1;
  active_network: string;
  preferences: {
    format: OutputFormat;
    api_url: string;
  };
  networks: Record<string, NetworkConfig>;
};

export type EffectiveConfig = {
  version: 1;
  activeNetwork: string;
  preferences: {
    format: OutputFormat;
    apiUrl: string;
  };
  activeAccount: {
    network: string;
    address: string;
    keyfile: string;
    expandedKeyfile: string;
  };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type RawConfig = {
  version?: unknown;
  active_network?: unknown;
  preferences?: {
    format?: unknown;
    api_url?: unknown;
  };
  networks?: Record<string, { address?: unknown; keyfile?: unknown }>;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOutputFormat(value: unknown): value is OutputFormat {
  return value === "table" || value === "json" || value === "yaml";
}

function validateAbsoluteUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Invalid preferences.api_url "${value}"`);
  }

  if (
    parsed.host.length === 0 ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    throw new ConfigError(`Invalid preferences.api_url "${value}"`);
  }
}

export function parseConfig(text: string): CorbitsConfig {
  let raw: RawConfig;
  try {
    raw = parse(text) as RawConfig;
  } catch (err) {
    throw new ConfigError(
      `Invalid config TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (raw.version !== 1) {
    throw new ConfigError("Config version must be 1");
  }
  if (!isNonEmptyString(raw.active_network)) {
    throw new ConfigError("Config active_network must be a non-empty string");
  }
  if (raw.preferences == null || typeof raw.preferences !== "object") {
    throw new ConfigError("Config preferences section is required");
  }
  if (!isOutputFormat(raw.preferences.format)) {
    throw new ConfigError(
      'Config preferences.format must be "table", "json", or "yaml"',
    );
  }
  if (!isNonEmptyString(raw.preferences.api_url)) {
    throw new ConfigError("Config preferences.api_url must be a non-empty URL");
  }
  validateAbsoluteUrl(raw.preferences.api_url);

  if (raw.networks == null || typeof raw.networks !== "object") {
    throw new ConfigError("Config networks section is required");
  }

  const networks = Object.entries(raw.networks).reduce<
    Record<string, NetworkConfig>
  >((acc, [name, network]) => {
    if (!isNonEmptyString(name)) {
      throw new ConfigError("Config network names must be non-empty strings");
    }
    if (network == null || typeof network !== "object") {
      throw new ConfigError(`Config networks.${name} must be a table`);
    }
    if (!isNonEmptyString(network.address)) {
      throw new ConfigError(
        `Config networks.${name}.address must be non-empty`,
      );
    }
    if (!isNonEmptyString(network.keyfile)) {
      throw new ConfigError(
        `Config networks.${name}.keyfile must be non-empty`,
      );
    }
    acc[name] = {
      address: network.address,
      keyfile: network.keyfile,
    };
    return acc;
  }, {});

  if (Object.keys(networks).length === 0) {
    throw new ConfigError("Config networks section must not be empty");
  }
  if (!(raw.active_network in networks)) {
    throw new ConfigError(
      `Config active_network "${raw.active_network}" must exist in networks`,
    );
  }

  return {
    version: 1,
    active_network: raw.active_network,
    preferences: {
      format: raw.preferences.format,
      api_url: raw.preferences.api_url,
    },
    networks,
  };
}

export function resolveEffectiveConfig(config: CorbitsConfig): EffectiveConfig {
  const active = config.networks[config.active_network];
  if (active == null) {
    throw new ConfigError(
      `Config active_network "${config.active_network}" must exist in networks`,
    );
  }

  return {
    version: config.version,
    activeNetwork: config.active_network,
    preferences: {
      format: config.preferences.format,
      apiUrl: config.preferences.api_url,
    },
    activeAccount: {
      network: config.active_network,
      address: active.address,
      keyfile: active.keyfile,
      expandedKeyfile: expandHome(active.keyfile),
    },
  };
}

export function normalizeConfig(config: CorbitsConfig): CorbitsConfig {
  const sortedNetworks = Object.fromEntries(
    Object.entries(config.networks).sort(([a], [b]) => a.localeCompare(b)),
  );

  return {
    version: 1,
    active_network: config.active_network,
    preferences: {
      format: config.preferences.format,
      api_url: config.preferences.api_url,
    },
    networks: sortedNetworks,
  };
}

export function stringifyConfig(config: CorbitsConfig): string {
  return stringify(normalizeConfig(config));
}
