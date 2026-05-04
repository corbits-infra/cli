import { command, option, optional, string } from "cmd-ts";
import { loadRequiredConfig } from "../config/index.js";
import {
  getWalletFamilyForNetwork,
  parsePaymentNetwork,
  getPaymentNetworkDefaults,
  formatPaymentNetworkDisplay,
} from "../config/schema.js";
import { ConfigError } from "../config/index.js";
import { printFormatted, printJSON, printYaml } from "../output/format.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";
import {
  buildTargetFromOverrides,
  resolveAssetBalance,
  defaultBalanceDeps,
  type BalanceDeps,
  type BalanceLookupTarget,
  type BalanceRecord,
} from "../payment/balance.js";
import { resolveKnownPaymentAsset } from "../payment/requirements.js";

type BalanceCommandDeps = {
  loadRequiredConfig: typeof loadRequiredConfig;
  resolveAssetBalance: typeof resolveAssetBalance;
  balanceDeps: BalanceDeps;
};

async function resolveTarget(
  networkArg: string | undefined,
  addressArg: string | undefined,
  deps: Pick<BalanceCommandDeps, "loadRequiredConfig">,
): Promise<{ target: BalanceLookupTarget; defaultAsset: string }> {
  if (addressArg != null && networkArg == null) {
    throw new ConfigError("--address requires --network");
  }

  if (networkArg != null && addressArg != null) {
    const network = parsePaymentNetwork(networkArg);
    return {
      target: buildTargetFromOverrides(network, addressArg),
      defaultAsset: getPaymentNetworkDefaults(network).asset,
    };
  }

  const { config, resolved } = await deps.loadRequiredConfig();

  if (networkArg != null) {
    const network = parsePaymentNetwork(networkArg);
    const networkFamily = getWalletFamilyForNetwork(network);
    if (networkFamily !== resolved.payment.family) {
      throw new ConfigError(
        `--network ${formatPaymentNetworkDisplay(network)} requires a ${networkFamily} wallet address; use --address to specify one`,
      );
    }
    const rpcURL =
      config.payment.rpc_url_overrides?.[network] ??
      getPaymentNetworkDefaults(network).rpcURL;
    return {
      target: { network, address: resolved.payment.address, rpcURL },
      defaultAsset: getPaymentNetworkDefaults(network).asset,
    };
  }

  return {
    target: {
      network: resolved.payment.network,
      address: resolved.payment.address,
      rpcURL: resolved.payment.rpcURL,
    },
    defaultAsset: resolved.payment.asset,
  };
}

export function createBalanceCommand(deps: BalanceCommandDeps) {
  return command({
    name: "balance",
    description: "Report a token balance for the configured wallet",
    args: {
      network: option({
        type: optional(string),
        long: "network",
        description: "Payment network to query (default: configured network)",
      }),
      address: option({
        type: optional(string),
        long: "address",
        description:
          "Wallet address to query (requires --network; default: configured wallet)",
      }),
      asset: option({
        type: optional(string),
        long: "asset",
        description:
          "Asset symbol or address to query (default: configured payment asset)",
      }),
      format: formatFlag,
    },
    handler: async ({ network, address, asset, format: formatArg }) => {
      const format = await resolveOutputFormat(formatArg);
      const { target, defaultAsset } = await resolveTarget(
        network,
        address,
        deps,
      );
      const resolvedAsset = resolveKnownPaymentAsset(
        target.network,
        asset ?? defaultAsset,
      );
      const record = await deps.resolveAssetBalance(
        target,
        resolvedAsset,
        deps.balanceDeps,
      );

      if (format === "json") {
        printJSON(record);
        return;
      }
      if (format === "yaml") {
        printYaml(record);
        return;
      }

      printFormatted<BalanceRecord>(
        "table",
        [record],
        ["Address", "Network", "Asset", "Asset Address", "Balance"],
        (r) => [r.address, r.network, r.asset, r.assetAddress, r.amount],
      );
    },
  });
}

export const balance = createBalanceCommand({
  loadRequiredConfig,
  resolveAssetBalance,
  balanceDeps: defaultBalanceDeps,
});
