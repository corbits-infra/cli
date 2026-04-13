import { command, option, optional, positional, string } from "cmd-ts";
import { printYaml, type OutputFormat } from "../output/format.js";
import { formatType } from "../flags.js";
import { getConfigPath } from "../config/path.js";
import { loadConfig, loadRequiredConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import {
  type CorbitsConfig,
  type NetworkConfig,
  ConfigError,
} from "../config/schema.js";

const stdout = (s: string) => process.stdout.write(s + "\n");

function requireValue(value: string | undefined, message: string): string {
  if (value == null || value.trim().length === 0) {
    throw new ConfigError(message);
  }
  return value;
}

function applyNetworkPatch(
  existing: NetworkConfig,
  patch: { address: string | undefined; keyfile: string | undefined },
): NetworkConfig {
  return {
    address: patch.address ?? existing.address,
    keyfile: patch.keyfile ?? existing.keyfile,
  };
}

async function saveAndPrint(
  path: string,
  config: CorbitsConfig,
  lines: string[],
): Promise<void> {
  await saveConfig(path, config);
  for (const line of lines) {
    stdout(line);
  }
}

export const config = command({
  name: "config",
  description: "Manage Corbits config",
  args: {
    action: positional({ type: optional(string), displayName: "action" }),
    target: positional({ type: optional(string), displayName: "target" }),
    value: positional({ type: optional(string), displayName: "value" }),
    network: option({
      type: optional(string),
      long: "network",
      description: "Network name for config init",
    }),
    address: option({
      type: optional(string),
      long: "address",
      description: "Address for network mutations",
    }),
    keyfile: option({
      type: optional(string),
      long: "keyfile",
      description: "Keyfile path for network mutations",
    }),
    format: option({
      type: optional(formatType),
      long: "format",
      description: "Default output format for future config consumers",
    }),
    apiUrl: option({
      type: optional(string),
      long: "api-url",
      description: "Override the Corbits API base URL",
    }),
  },
  handler: async ({
    action,
    target,
    value,
    network,
    address,
    keyfile,
    format,
    apiUrl,
  }) => {
    if (action == null) {
      const loaded = await loadConfig();
      if (loaded == null) {
        stdout("config: not initialized");
        stdout(`path: ${getConfigPath()}`);
        stdout(
          "help: Run `corbits config init --network <name> --address <addr> --keyfile <path>`",
        );
        return;
      }

      printYaml({
        version: loaded.config.version,
        active_network: loaded.effective.activeNetwork,
        preferences: loaded.config.preferences,
        active_account: {
          address: loaded.effective.activeAccount.address,
          keyfile: loaded.effective.activeAccount.keyfile,
          expanded_keyfile: loaded.effective.activeAccount.expandedKeyfile,
        },
        networks: loaded.config.networks,
      });
      return;
    }

    if (action === "init") {
      const configPath = getConfigPath();
      const existing = await loadConfig();
      if (existing != null) {
        stdout("config: already initialized (no-op)");
        stdout(`active_network: ${existing.effective.activeNetwork}`);
        return;
      }

      const initialNetwork = requireValue(
        network,
        "config init requires --network <name>",
      );
      const initialAddress = requireValue(
        address,
        "config init requires --address <addr>",
      );
      const initialKeyfile = requireValue(
        keyfile,
        "config init requires --keyfile <path>",
      );

      const initialConfig: CorbitsConfig = {
        version: 1,
        active_network: initialNetwork,
        preferences: {
          format: format ?? "table",
          api_url: apiUrl ?? "https://api.corbits.dev",
        },
        networks: {
          [initialNetwork]: {
            address: initialAddress,
            keyfile: initialKeyfile,
          },
        },
      };

      await saveAndPrint(configPath, initialConfig, [
        "config: initialized",
        `active_network: ${initialNetwork}`,
      ]);
      return;
    }

    if (action === "use") {
      const networkName = requireValue(target, "config use requires <network>");
      const loaded = await loadRequiredConfig();
      if (!(networkName in loaded.config.networks)) {
        throw new ConfigError(`Unknown network "${networkName}"`);
      }
      if (loaded.config.active_network === networkName) {
        stdout(`active_network: ${networkName} (no-op)`);
        return;
      }
      loaded.config.active_network = networkName;
      await saveAndPrint(loaded.path, loaded.config, [
        `active_network: ${networkName}`,
      ]);
      return;
    }

    if (action === "network") {
      const mutation = requireValue(
        target,
        "config network requires one of: add, update, remove",
      );
      const networkName = requireValue(
        value,
        `config network ${mutation} requires <name>`,
      );
      const loaded = await loadRequiredConfig();

      if (mutation === "add") {
        if (networkName in loaded.config.networks) {
          throw new ConfigError(`Network "${networkName}" already exists`);
        }
        loaded.config.networks[networkName] = {
          address: requireValue(
            address,
            "config network add requires --address <addr>",
          ),
          keyfile: requireValue(
            keyfile,
            "config network add requires --keyfile <path>",
          ),
        };
        await saveAndPrint(loaded.path, loaded.config, [
          `network: added ${networkName}`,
        ]);
        return;
      }

      if (mutation === "update") {
        const existing = loaded.config.networks[networkName];
        if (existing == null) {
          throw new ConfigError(`Unknown network "${networkName}"`);
        }
        if (address == null && keyfile == null) {
          throw new ConfigError(
            "config network update requires --address <addr> and/or --keyfile <path>",
          );
        }
        loaded.config.networks[networkName] = applyNetworkPatch(existing, {
          address,
          keyfile,
        });
        await saveAndPrint(loaded.path, loaded.config, [
          `network: updated ${networkName}`,
        ]);
        return;
      }

      if (mutation === "remove") {
        if (!(networkName in loaded.config.networks)) {
          throw new ConfigError(`Unknown network "${networkName}"`);
        }
        if (loaded.config.active_network === networkName) {
          throw new ConfigError(
            `Cannot remove active network "${networkName}"`,
          );
        }
        loaded.config.networks = Object.fromEntries(
          Object.entries(loaded.config.networks).filter(
            ([name]) => name !== networkName,
          ),
        );
        await saveAndPrint(loaded.path, loaded.config, [
          `network: removed ${networkName}`,
        ]);
        return;
      }

      throw new ConfigError(
        `Unknown config network action "${mutation}". Expected add, update, or remove`,
      );
    }

    if (action === "format") {
      const nextFormat = requireValue(
        target,
        "config format requires <table|json|yaml>",
      );
      if (
        nextFormat !== "table" &&
        nextFormat !== "json" &&
        nextFormat !== "yaml"
      ) {
        throw new ConfigError(
          'config format requires one of: "table", "json", "yaml"',
        );
      }
      const loaded = await loadRequiredConfig();
      loaded.config.preferences.format = nextFormat as OutputFormat;
      await saveAndPrint(loaded.path, loaded.config, [`format: ${nextFormat}`]);
      return;
    }

    if (action === "api-url") {
      const nextApiUrl = requireValue(target, "config api-url requires <url>");
      const loaded = await loadRequiredConfig();
      loaded.config.preferences.api_url = nextApiUrl;
      await saveAndPrint(loaded.path, loaded.config, [
        `api_url: ${nextApiUrl}`,
      ]);
      return;
    }

    throw new ConfigError(
      `Unknown config action "${action}". Expected init, use, network, format, or api-url`,
    );
  },
});
