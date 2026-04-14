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
  if (network in PAYER_NETWORKS) {
    return PAYER_NETWORKS[network as SupportedConfigNetwork];
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
  return async function buildPayer(config: ResolvedConfig) {
    const network = getSupportedPayerNetwork(config.payment.network);
    const payer = deps.createPayer({
      networks: [network],
      assets: ["USDC"],
    });

    await attachWalletToPayer(payer, config, deps);
    return payer;
  };
}

export const buildPayer = createBuildPayer({
  createPayer,
  buildOwsAdapter,
});
