import { ConfigError } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { buildOwsAdapter } from "./ows.js";
import { createPayer } from "@faremeter/rides";

type CreatePayerFn = typeof createPayer;
type Payer = ReturnType<CreatePayerFn>;

type BuildPayerDeps = {
  createPayer: CreatePayerFn;
  buildOwsAdapter: typeof buildOwsAdapter;
};

type BuildPayerArgs = Parameters<CreatePayerFn>[0];

type SupportedConfigNetwork = Exclude<
  ResolvedConfig["payment"]["network"],
  "localnet"
>;
type PayerNetwork = NonNullable<
  NonNullable<Parameters<CreatePayerFn>[0]>["networks"]
>[number];

const PAYER_NETWORKS: Record<SupportedConfigNetwork, PayerNetwork> = {
  devnet: "solana-devnet",
  "mainnet-beta": "solana",
  base: "base",
  "base-sepolia": "base-sepolia",
};

function getSupportedPayerNetwork(
  network: ResolvedConfig["payment"]["network"],
): PayerNetwork {
  switch (network) {
    case "devnet":
    case "mainnet-beta":
    case "base":
    case "base-sepolia":
      return PAYER_NETWORKS[network];
  }

  throw new ConfigError(`corbits call does not support network ${network}`);
}

async function attachWalletToPayer(
  payer: Payer,
  config: ResolvedConfig,
  deps: BuildPayerDeps,
): Promise<void> {
  const walletKind = config.activeWallet.kind;

  switch (walletKind) {
    case "keypair":
      await payer.addLocalWallet(config.activeWallet.expandedPath);
      return;
    case "ows":
      payer.addWalletAdapter(await deps.buildOwsAdapter(config));
      return;
    default:
      throw new ConfigError(
        `corbits call does not support wallet kind ${walletKind}`,
      );
  }
}

export function createBuildPayer(deps: BuildPayerDeps) {
  return async function buildPayer(
    config: ResolvedConfig,
    args?: BuildPayerArgs,
  ) {
    const network = getSupportedPayerNetwork(config.payment.network);
    const payerArgs: BuildPayerArgs = {
      networks: [network],
      assets: ["USDC"],
      ...(args?.fetch == null ? {} : { fetch: args.fetch }),
      ...(args?.options == null ? {} : { options: args.options }),
    };
    const payer = deps.createPayer(payerArgs);

    await attachWalletToPayer(payer, config, deps);
    return payer;
  };
}

export const buildPayer = createBuildPayer({
  createPayer,
  buildOwsAdapter,
});
