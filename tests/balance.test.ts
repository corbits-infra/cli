#!/usr/bin/env pnpm tsx

import t from "tap";
import { createBalanceCommand } from "../src/commands/balance.js";
import {
  checkPreflightBalance,
  buildTargetFromOverrides,
  resolveAssetBalance,
  resolveUsdcBalance,
  validateAddressForNetwork,
  type BalanceDeps,
  type PreflightBalanceDeps,
} from "../src/payment/balance.js";
import type { WrappedRunResult } from "../src/process/wrapped-client.js";
import type { LoadedConfig, ResolvedConfig } from "../src/config/index.js";
import { captureStdout } from "./test-helpers.js";
import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";
import type { KnownPaymentAssetDetails } from "../src/payment/requirements.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const solanaConfig: ResolvedConfig = {
  version: 1 as const,
  preferences: { format: "table" as const, apiUrl: "https://api.corbits.dev" },
  payment: {
    network: "devnet" as const,
    family: "solana" as const,
    address: "So11111111111111111111111111111111111111112",
    asset: "USDC",
    rpcUrl: "https://api.devnet.solana.com",
  },
  activeWallet: {
    kind: "keypair" as const,
    family: "solana" as const,
    address: "So11111111111111111111111111111111111111112",
    path: "~/.config/solana/id.json",
    expandedPath: "/tmp/id.json",
  },
};

function makeBalanceDeps(rawAmount: bigint): BalanceDeps {
  return {
    getSolanaTokenBalance: async () => rawAmount,
    getEvmPublicClient: () => {
      throw new Error("unexpected EVM client creation");
    },
    lookupKnownSPLToken: (() => ({
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      name: "USDC",
    })) as never,
    lookupKnownAsset: (() => ({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      contractName: "USD Coin",
    })) as never,
  };
}

function makeEvmBalanceDeps(rawAmount: bigint): BalanceDeps {
  return {
    getSolanaTokenBalance: async () => {
      throw new Error("unexpected Solana balance call");
    },
    getEvmPublicClient: () =>
      ({
        multicall: async () => [
          { status: "success", result: rawAmount },
          { status: "success", result: 6 },
        ],
      }) as never,
    lookupKnownSPLToken: (() => undefined) as never,
    lookupKnownAsset: (() => ({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      contractName: "USD Coin",
    })) as never,
  };
}

function makePreflightDeps(
  rawAmount: bigint,
  accepts: x402PaymentRequirementsV2[],
  options?: { receiverAccountExists?: boolean },
): PreflightBalanceDeps {
  return {
    ...makeBalanceDeps(rawAmount),
    parseRequirements: async () => ({ accepts }),
    solanaTokenAccountExists: async () =>
      options?.receiverAccountExists ?? true,
  };
}

function makeRequirement(args: {
  network: string;
  amount: string;
  asset?: string;
  decimals?: number;
}): x402PaymentRequirementsV2 {
  return {
    scheme: "exact",
    network: args.network,
    amount: args.amount,
    asset: args.asset ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    payTo: "receiver",
    maxTimeoutSeconds: 60,
    ...(args.decimals == null ? {} : { extra: { decimals: args.decimals } }),
  };
}

function makePaymentRequiredResult(args?: {
  accepts?: x402PaymentRequirementsV2[];
}): Extract<WrappedRunResult, { kind: "payment-required" }> {
  const accepts = args?.accepts ?? [
    makeRequirement({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "100000",
      decimals: 6,
    }),
  ];
  return {
    kind: "payment-required",
    tool: "curl",
    url: "https://example.com",
    requestInit: { method: "GET" },
    response: new Response(JSON.stringify({ x402Version: 1, accepts }), {
      status: 402,
    }),
  };
}

function makeLoadedConfig(resolved = solanaConfig): LoadedConfig {
  return {
    path: "/tmp/config.toml",
    config: {
      version: 1,
      preferences: { format: "table", api_url: "https://api.corbits.dev" },
      payment: { network: "devnet" },
      wallets: {
        solana: {
          kind: "keypair",
          address: "So11111111111111111111111111111111111111112",
          path: "~/.config/solana/id.json",
        },
      },
    },
    resolved,
  };
}

const usdcAsset = {
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  symbol: "USDC",
  decimals: 6,
} satisfies KnownPaymentAssetDetails;

const usdtAsset = {
  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  symbol: "USDT",
  decimals: 6,
} satisfies KnownPaymentAssetDetails;

const baseUsdcAsset = {
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  decimals: 6,
} satisfies KnownPaymentAssetDetails;

// ── resolveAssetBalance ───────────────────────────────────────────────────────

await t.test("resolveAssetBalance", async (t) => {
  await t.test("formats Solana asset balance for a zero balance", async (t) => {
    const record = await resolveAssetBalance(
      {
        network: "devnet",
        address: "So11111111111111111111111111111111111111112",
        rpcUrl: "https://api.devnet.solana.com",
      },
      usdcAsset,
      makeBalanceDeps(0n),
    );
    t.equal(record.amount, "0.000000");
    t.equal(record.asset, "USDC");
    t.equal(record.assetAddress, usdcAsset.asset);
    t.equal(record.network, "solana-devnet");
  });

  await t.test(
    "formats Solana asset balance for a fractional amount",
    async (t) => {
      const record = await resolveAssetBalance(
        {
          network: "devnet",
          address: "So11111111111111111111111111111111111111112",
          rpcUrl: "https://api.devnet.solana.com",
        },
        usdtAsset,
        makeBalanceDeps(500000n),
      );
      t.equal(record.amount, "0.500000");
      t.equal(record.asset, "USDT");
      t.equal(record.assetAddress, usdtAsset.asset);
    },
  );

  await t.test(
    "formats EVM asset balance using contract-reported decimals",
    async (t) => {
      const record = await resolveAssetBalance(
        {
          network: "base",
          address: "0x1234000000000000000000000000000000000000",
          rpcUrl: "https://mainnet.base.org",
        },
        baseUsdcAsset,
        makeEvmBalanceDeps(1_500_000n),
      );
      t.equal(record.amount, "1.500000");
      t.equal(record.network, "base");
      t.equal(record.asset, "USDC");
      t.equal(record.assetAddress, baseUsdcAsset.asset);
    },
  );
});

// ── resolveUsdcBalance ────────────────────────────────────────────────────────

await t.test("resolveUsdcBalance", async (t) => {
  await t.test("formats Solana USDC balance for a zero balance", async (t) => {
    const record = await resolveUsdcBalance(
      {
        network: "devnet",
        address: "So11111111111111111111111111111111111111112",
        rpcUrl: "https://api.devnet.solana.com",
      },
      makeBalanceDeps(0n),
    );
    t.equal(record.amount, "0.000000");
    t.equal(record.asset, "USDC");
    t.equal(record.assetAddress, usdcAsset.asset);
    t.equal(record.network, "solana-devnet");
  });

  await t.test(
    "formats Solana USDC balance for a fractional amount",
    async (t) => {
      const record = await resolveUsdcBalance(
        {
          network: "devnet",
          address: "So11111111111111111111111111111111111111112",
          rpcUrl: "https://api.devnet.solana.com",
        },
        makeBalanceDeps(500000n),
      );
      t.equal(record.amount, "0.500000");
      t.equal(record.assetAddress, usdcAsset.asset);
    },
  );

  await t.test("formats Solana USDC balance for a whole amount", async (t) => {
    const record = await resolveUsdcBalance(
      {
        network: "mainnet-beta",
        address: "So11111111111111111111111111111111111111112",
        rpcUrl: "https://api.mainnet-beta.solana.com",
      },
      makeBalanceDeps(10_000_000n),
    );
    t.equal(record.amount, "10.000000");
    t.equal(record.network, "solana-mainnet-beta");
    t.equal(
      record.assetAddress,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  await t.test(
    "formats EVM USDC balance using contract-reported decimals",
    async (t) => {
      const record = await resolveUsdcBalance(
        {
          network: "base",
          address: "0x1234000000000000000000000000000000000000",
          rpcUrl: "https://mainnet.base.org",
        },
        makeEvmBalanceDeps(1_500_000n),
      );
      t.equal(record.amount, "1.500000");
      t.equal(record.network, "base");
      t.equal(record.asset, "USDC");
      t.equal(record.assetAddress, baseUsdcAsset.asset);
    },
  );
});

// ── validateAddressForNetwork ─────────────────────────────────────────────────

await t.test("validateAddressForNetwork", async (t) => {
  await t.test("accepts a valid Solana public key", async (t) => {
    t.doesNotThrow(() =>
      validateAddressForNetwork(
        "So11111111111111111111111111111111111111112",
        "devnet",
      ),
    );
  });

  await t.test("rejects an invalid Solana address", async (t) => {
    t.throws(
      () => validateAddressForNetwork("not-a-pubkey", "devnet"),
      /Invalid Solana address/,
    );
  });

  await t.test("accepts a valid EVM hex address", async (t) => {
    t.doesNotThrow(() =>
      validateAddressForNetwork(
        "0x1234000000000000000000000000000000000000",
        "base",
      ),
    );
  });

  await t.test("rejects an invalid EVM hex address", async (t) => {
    t.throws(
      () => validateAddressForNetwork("not-an-address", "base"),
      /Invalid EVM address/,
    );
  });
});

// ── buildTargetFromOverrides ──────────────────────────────────────────────────

await t.test("buildTargetFromOverrides", async (t) => {
  await t.test("builds a Solana target with default RPC URL", async (t) => {
    const target = buildTargetFromOverrides(
      "devnet",
      "So11111111111111111111111111111111111111112",
    );
    t.equal(target.network, "devnet");
    t.equal(target.address, "So11111111111111111111111111111111111111112");
    t.match(target.rpcUrl, /devnet\.solana\.com/);
  });

  await t.test("builds an EVM target with default RPC URL", async (t) => {
    const target = buildTargetFromOverrides(
      "base",
      "0x1234000000000000000000000000000000000000",
    );
    t.equal(target.network, "base");
    t.match(target.rpcUrl, /base\.org/);
  });

  await t.test(
    "throws for an invalid address on the given network",
    async (t) => {
      t.throws(
        () => buildTargetFromOverrides("devnet", "0xinvalid"),
        /Invalid Solana address/,
      );
    },
  );
});

// ── checkPreflightBalance ─────────────────────────────────────────────────────

await t.test("checkPreflightBalance", async (t) => {
  await t.test("passes when balance equals the required amount", async (t) => {
    await t.resolves(
      checkPreflightBalance(
        solanaConfig,
        makePaymentRequiredResult({
          accepts: [
            makeRequirement({
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "100000",
              decimals: 6,
            }),
          ],
        }),
        makePreflightDeps(100000n, [
          makeRequirement({
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "100000",
            decimals: 6,
          }),
        ]),
      ),
    );
  });

  await t.test("passes when balance exceeds the required amount", async (t) => {
    await t.resolves(
      checkPreflightBalance(
        solanaConfig,
        makePaymentRequiredResult(),
        makePreflightDeps(500000n, [
          makeRequirement({
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "100000",
            decimals: 6,
          }),
        ]),
      ),
    );
  });

  await t.test(
    "reports when the Solana receiver token account is missing",
    async (t) => {
      await t.rejects(
        checkPreflightBalance(
          {
            ...solanaConfig,
            payment: {
              ...solanaConfig.payment,
              asset: "USDT",
              network: "mainnet-beta",
              rpcUrl: "https://api.mainnet-beta.solana.com",
            },
          },
          makePaymentRequiredResult({
            accepts: [
              {
                ...makeRequirement({
                  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                  amount: "100000",
                  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                  decimals: 6,
                }),
                payTo: "LCQf3TfH7set8drA12p8bHDaBn9yXq7KauP8NFRHubq",
                extra: {
                  decimals: 6,
                  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                },
              },
            ],
          }),
          makePreflightDeps(
            500000n,
            [
              {
                ...makeRequirement({
                  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                  amount: "100000",
                  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                  decimals: 6,
                }),
                payTo: "LCQf3TfH7set8drA12p8bHDaBn9yXq7KauP8NFRHubq",
                extra: {
                  decimals: 6,
                  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                },
              },
            ],
            { receiverAccountExists: false },
          ),
        ),
        /Endpoint advertises USDT on solana-mainnet-beta, but the receiver token account is not initialized yet/,
      );
    },
  );

  await t.test(
    "throws with the correct message when balance is insufficient",
    async (t) => {
      await t.rejects(
        checkPreflightBalance(
          solanaConfig,
          makePaymentRequiredResult(),
          makePreflightDeps(50000n, [
            makeRequirement({
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "100000",
              decimals: 6,
            }),
          ]),
        ),
        /Insufficient USDC balance \(have 0\.050000, endpoint costs 0\.100000\)/,
      );
    },
  );

  await t.test(
    "reports when no accepted asset matches the active payment network",
    async (t) => {
      await t.rejects(
        checkPreflightBalance(
          solanaConfig,
          makePaymentRequiredResult(),
          makePreflightDeps(0n, [
            makeRequirement({
              network: "eip155:8453",
              amount: "100000",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              decimals: 6,
            }),
          ]),
        ),
        /server only offered EVM x402 payment requirements .* active payment network is devnet/,
      );
    },
  );

  await t.test(
    "matches the configured network when multiple family requirements are present",
    async (t) => {
      await t.rejects(
        checkPreflightBalance(
          solanaConfig,
          makePaymentRequiredResult(),
          makePreflightDeps(50000n, [
            makeRequirement({
              network: "solana:mainnet",
              amount: "1000000",
              asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              decimals: 6,
            }),
            makeRequirement({
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "200000",
              decimals: 6,
            }),
          ]),
        ),
        /have 0\.050000, endpoint costs 0\.200000/,
      );
    },
  );
});

// ── balance command ───────────────────────────────────────────────────────────

await t.test("balance command", async (t) => {
  await t.test(
    "reports balance using configured wallet and network",
    async (t) => {
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () => makeLoadedConfig(),
        resolveAssetBalance: async () => ({
          address: "So11111111111111111111111111111111111111112",
          network: "solana-devnet",
          asset: "USDC",
          assetAddress: usdcAsset.asset,
          amount: "1.500000",
        }),
        balanceDeps: makeBalanceDeps(1_500_000n),
      });

      const stdout = await captureStdout(() =>
        cmd.handler({
          network: undefined,
          address: undefined,
          asset: undefined,
          format: undefined,
        }),
      );

      t.match(stdout, /So111111/);
      t.match(stdout, /solana-devnet/);
      t.match(stdout, /USDC/);
      t.match(stdout, new RegExp(usdcAsset.asset));
      t.match(stdout, /1\.500000/);
    },
  );

  await t.test("outputs JSON when format is json", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveAssetBalance: async () => ({
        address: "So11111111111111111111111111111111111111112",
        network: "solana-devnet",
        asset: "USDC",
        assetAddress: usdcAsset.asset,
        amount: "0.500000",
      }),
      balanceDeps: makeBalanceDeps(500000n),
    });

    const stdout = await captureStdout(() =>
      cmd.handler({
        network: undefined,
        address: undefined,
        asset: undefined,
        format: "json",
      }),
    );

    const parsed = JSON.parse(stdout) as {
      address: string;
      network: string;
      asset: string;
      assetAddress: string;
      amount: string;
    };
    t.equal(parsed.amount, "0.500000");
    t.equal(parsed.asset, "USDC");
    t.equal(parsed.assetAddress, usdcAsset.asset);
  });

  await t.test(
    "uses --network and --address overrides without config",
    async (t) => {
      let capturedTarget: unknown;
      let capturedAsset: KnownPaymentAssetDetails | undefined;
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () => {
          throw new Error("config should not be loaded for full override");
        },
        resolveAssetBalance: async (target, asset) => {
          capturedTarget = target;
          capturedAsset = asset;
          return {
            address: target.address,
            network: "solana-devnet",
            asset: "USDC",
            assetAddress: usdcAsset.asset,
            amount: "2.000000",
          };
        },
        balanceDeps: makeBalanceDeps(2_000_000n),
      });

      await cmd.handler({
        network: "devnet",
        address: "So11111111111111111111111111111111111111112",
        asset: undefined,
        format: undefined,
      });

      t.same((capturedTarget as { network: string }).network, "devnet");
      t.same(
        (capturedTarget as { address: string }).address,
        "So11111111111111111111111111111111111111112",
      );
      t.same(capturedAsset, usdcAsset);
    },
  );

  await t.test(
    "uses the selected symbol override on the configured network",
    async (t) => {
      let capturedAsset: KnownPaymentAssetDetails | undefined;
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () =>
          makeLoadedConfig({
            ...solanaConfig,
            payment: {
              ...solanaConfig.payment,
              network: "mainnet-beta",
              rpcUrl: "https://api.mainnet-beta.solana.com",
            },
          }),
        resolveAssetBalance: async (_target, asset) => {
          capturedAsset = asset;
          return {
            address: "So11111111111111111111111111111111111111112",
            network: "solana-mainnet-beta",
            asset: asset.symbol,
            assetAddress: asset.asset,
            amount: "4.000000",
          };
        },
        balanceDeps: makeBalanceDeps(4_000_000n),
      });

      await cmd.handler({
        network: undefined,
        address: undefined,
        asset: "usdt",
        format: undefined,
      });

      t.same(capturedAsset, {
        asset: usdtAsset.asset,
        symbol: "USDT",
        decimals: 6,
      });
    },
  );

  await t.test(
    "normalizes EVM asset address overrides to the registry address",
    async (t) => {
      let capturedAsset: KnownPaymentAssetDetails | undefined;
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () =>
          makeLoadedConfig({
            ...solanaConfig,
            payment: {
              ...solanaConfig.payment,
              network: "base",
              family: "evm",
              address: "0x1234000000000000000000000000000000000000",
              rpcUrl: "https://mainnet.base.org",
            },
            activeWallet: {
              kind: "ows",
              family: "evm",
              address: "0x1234000000000000000000000000000000000000",
              walletId: "primary-evm",
            },
          }),
        resolveAssetBalance: async (_target, asset) => {
          capturedAsset = asset;
          return {
            address: "0x1234000000000000000000000000000000000000",
            network: "base",
            asset: asset.symbol,
            assetAddress: asset.asset,
            amount: "5.000000",
          };
        },
        balanceDeps: makeEvmBalanceDeps(5_000_000n),
      });

      await cmd.handler({
        network: undefined,
        address: undefined,
        asset: "0x833589fcD6EDB6E08F4c7c32d4f71B54bDA02913",
        format: undefined,
      });

      t.same(capturedAsset, baseUsdcAsset);
    },
  );

  await t.test("rejects unknown symbols before balance lookup", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveAssetBalance: async () => {
        throw new Error("should not reach balance lookup");
      },
      balanceDeps: makeBalanceDeps(0n),
    });

    await t.rejects(
      cmd.handler({
        network: undefined,
        address: undefined,
        asset: "notreal",
        format: undefined,
      }),
      /Unknown asset symbol notreal for solana-devnet/,
    );
  });

  await t.test(
    "rejects unregistered addresses before balance lookup",
    async (t) => {
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () =>
          makeLoadedConfig({
            ...solanaConfig,
            payment: {
              ...solanaConfig.payment,
              network: "mainnet-beta",
              rpcUrl: "https://api.mainnet-beta.solana.com",
            },
          }),
        resolveAssetBalance: async () => {
          throw new Error("should not reach balance lookup");
        },
        balanceDeps: makeBalanceDeps(0n),
      });

      await t.rejects(
        cmd.handler({
          network: undefined,
          address: undefined,
          asset: "So11111111111111111111111111111111111111112",
          format: undefined,
        }),
        /Asset address So11111111111111111111111111111111111111112 is not registered on solana-mainnet-beta/,
      );
    },
  );

  await t.test("fails when --address is given without --network", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveAssetBalance: async () => {
        throw new Error("should not reach balance lookup");
      },
      balanceDeps: makeBalanceDeps(0n),
    });

    await t.rejects(
      cmd.handler({
        network: undefined,
        address: "So11111111111111111111111111111111111111112",
        asset: undefined,
        format: undefined,
      }),
      /--address requires --network/,
    );
  });

  await t.test(
    "fails when --network family mismatches config wallet",
    async (t) => {
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () => makeLoadedConfig(),
        resolveAssetBalance: async () => {
          throw new Error("should not reach balance lookup");
        },
        balanceDeps: makeBalanceDeps(0n),
      });

      await t.rejects(
        cmd.handler({
          network: "base",
          address: undefined,
          asset: undefined,
          format: undefined,
        }),
        /requires a evm wallet address/,
      );
    },
  );

  await t.test(
    "uses --network with config wallet when families match",
    async (t) => {
      let capturedTarget: unknown;
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () => makeLoadedConfig(),
        resolveAssetBalance: async (target) => {
          capturedTarget = target;
          return {
            address: target.address,
            network: "solana-mainnet-beta",
            asset: "USDC",
            assetAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: "3.000000",
          };
        },
        balanceDeps: makeBalanceDeps(3_000_000n),
      });

      await cmd.handler({
        network: "mainnet-beta",
        address: undefined,
        asset: undefined,
        format: undefined,
      });

      t.same((capturedTarget as { network: string }).network, "mainnet-beta");
      t.same(
        (capturedTarget as { address: string }).address,
        "So11111111111111111111111111111111111111112",
      );
    },
  );

  await t.test("outputs stderr for balance errors", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveAssetBalance: async () => {
        throw new Error("RPC connection failed");
      },
      balanceDeps: makeBalanceDeps(0n),
    });

    await t.rejects(
      cmd.handler({
        network: undefined,
        address: undefined,
        asset: undefined,
        format: undefined,
      }),
      /RPC connection failed/,
    );
  });
});
