import { command, option, optional, string } from "cmd-ts";
import { loadRequiredConfig } from "../config/index.js";
import {
  getWalletFamilyForNetwork,
  parsePaymentNetwork,
  getPaymentNetworkDefaults,
  formatPaymentNetworkDisplay,
} from "../config/schema.js";
import { ConfigError } from "../config/index.js";
import { printFormatted, printJson, printYaml } from "../output/format.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";
import {
  buildTargetFromOverrides,
  resolveUsdcBalance,
  defaultBalanceDeps,
  type BalanceDeps,
  type BalanceLookupTarget,
  type BalanceRecord,
} from "../payment/balance.js";

type BalanceCommandDeps = {
  loadRequiredConfig: typeof loadRequiredConfig;
  resolveUsdcBalance: typeof resolveUsdcBalance;
  balanceDeps: BalanceDeps;
};

async function resolveTarget(
  networkArg: string | undefined,
  addressArg: string | undefined,
  deps: Pick<BalanceCommandDeps, "loadRequiredConfig">,
): Promise<BalanceLookupTarget> {
  if (addressArg != null && networkArg == null) {
    throw new ConfigError("--address requires --network");
  }

  if (networkArg != null && addressArg != null) {
    const network = parsePaymentNetwork(networkArg);
    return buildTargetFromOverrides(network, addressArg);
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
    const rpcUrl =
      config.payment.rpc_url_overrides?.[network] ??
      getPaymentNetworkDefaults(network).rpcUrl;
    return { network, address: resolved.payment.address, rpcUrl };
  }

  return {
    network: resolved.payment.network,
    address: resolved.payment.address,
    rpcUrl: resolved.payment.rpcUrl,
  };
}

export function createBalanceCommand(deps: BalanceCommandDeps) {
  return command({
    name: "balance",
    description: "Report the USDC balance for the configured wallet",
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
      format: formatFlag,
    },
    handler: async ({ network, address, format: formatArg }) => {
      const format = await resolveOutputFormat(formatArg);
      const target = await resolveTarget(network, address, deps);
      const record = await deps.resolveUsdcBalance(target, deps.balanceDeps);

      if (format === "json") {
        printJson(record);
        return;
      }
      if (format === "yaml") {
        printYaml(record);
        return;
      }

      printFormatted<BalanceRecord>(
        "table",
        [record],
        ["Address", "Network", "Asset", "Balance"],
        (r) => [r.address, r.network, r.asset, r.amount],
      );
    },
  });
}

export const balance = createBalanceCommand({
  loadRequiredConfig,
  resolveUsdcBalance,
  balanceDeps: defaultBalanceDeps,
});
