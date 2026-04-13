import type { OutputFormat } from "../output/format.js";
import {
  printJson,
  printTable,
  printYaml,
  writeLine,
} from "../output/format.js";
import type { WalletConfig } from "./schema.js";
import type { LoadedConfig } from "./store.js";

type ConfigView = {
  path: string;
  version: 1;
  preferences: {
    format: OutputFormat;
    api_url: string;
  };
  payment: {
    network: string;
    family: string;
    address: string;
    asset: string;
    rpc_url: string;
    rpc_url_override?: string;
  };
  active_wallet:
    | {
        address: string;
        family: string;
        kind: "keypair";
        path: string;
        expanded_path: string;
      }
    | {
        address: string;
        family: string;
        kind: "ows";
        wallet_id: string;
      };
  wallets: {
    solana?: WalletConfig;
    evm?: WalletConfig;
  };
};

function buildActiveWalletView(
  loaded: LoadedConfig,
): ConfigView["active_wallet"] {
  if (loaded.resolved.activeWallet.kind === "keypair") {
    return {
      address: loaded.resolved.activeWallet.address,
      family: loaded.resolved.activeWallet.family,
      kind: "keypair",
      path: loaded.resolved.activeWallet.path,
      expanded_path: loaded.resolved.activeWallet.expandedPath,
    };
  }

  return {
    address: loaded.resolved.activeWallet.address,
    family: loaded.resolved.activeWallet.family,
    kind: "ows",
    wallet_id: loaded.resolved.activeWallet.walletId,
  };
}

function buildConfigView(loaded: LoadedConfig): ConfigView {
  return {
    path: loaded.path,
    version: loaded.config.version,
    preferences: loaded.config.preferences,
    payment: {
      network: loaded.resolved.payment.network,
      family: loaded.resolved.payment.family,
      address: loaded.resolved.payment.address,
      asset: loaded.resolved.payment.asset,
      rpc_url: loaded.resolved.payment.rpcUrl,
      ...(loaded.config.payment.rpc_url_overrides?.[
        loaded.config.payment.network
      ] == null
        ? {}
        : {
            rpc_url_override:
              loaded.config.payment.rpc_url_overrides[
                loaded.config.payment.network
              ],
          }),
    },
    active_wallet: buildActiveWalletView(loaded),
    wallets: loaded.config.wallets,
  };
}

export function printConfigView(
  loaded: LoadedConfig,
  format: OutputFormat,
): void {
  const view = buildConfigView(loaded);

  if (format === "json") {
    printJson(view);
    return;
  }

  if (format === "yaml") {
    printYaml(view);
    return;
  }

  writeLine(`Config path: ${view.path}`);
  writeLine(`Payment network: ${view.payment.network}`);
  writeLine(`Payment family: ${view.payment.family}`);
  writeLine(`Default format: ${view.preferences.format}`);
  writeLine(`API URL: ${view.preferences.api_url}`);
  writeLine(`Payment address: ${view.payment.address}`);
  writeLine(`Payment asset: ${view.payment.asset}`);
  writeLine(`Payment RPC URL: ${view.payment.rpc_url}`);
  if (view.payment.rpc_url_override != null) {
    writeLine(`Payment RPC override: ${view.payment.rpc_url_override}`);
  }

  if (view.active_wallet.kind === "keypair") {
    writeLine(`Active wallet: ${view.active_wallet.family} keypair`);
    writeLine(`Active wallet address: ${view.active_wallet.address}`);
    writeLine(`Active wallet path: ${view.active_wallet.path}`);
    writeLine(`Expanded wallet path: ${view.active_wallet.expanded_path}`);
  } else {
    writeLine(`Active wallet: ${view.active_wallet.family} ows`);
    writeLine(`Active wallet address: ${view.active_wallet.address}`);
    writeLine(`Active wallet id: ${view.active_wallet.wallet_id}`);
  }

  writeLine("");

  const rows = Object.entries(view.wallets).map(([family, wallet]) => [
    family,
    wallet.address,
    wallet.kind,
    wallet.kind === "keypair" ? wallet.path : wallet.wallet_id,
  ]);

  printTable(["Wallet Family", "Address", "Kind", "Source"], rows);
}

export function printMissingConfig(path: string, format: OutputFormat): void {
  const payload = {
    initialized: false,
    path,
    help: "Run `corbits config init --network <name> --solana-address <addr> --solana-path <path>` or the matching EVM flags, plus optional `--rpc-url <url>`",
  };

  if (format === "json") {
    printJson(payload);
    return;
  }

  if (format === "yaml") {
    printYaml(payload);
    return;
  }

  writeLine("config: not initialized");
  writeLine(`path: ${path}`);
  writeLine(payload.help);
}
