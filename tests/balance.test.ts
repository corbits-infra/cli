#!/usr/bin/env pnpm tsx

import t from "tap";
import { createBalanceCommand } from "../src/commands/balance.js";
import {
  checkPreflightBalance,
  buildTargetFromOverrides,
  resolveUsdcBalance,
  validateAddressForNetwork,
  type BalanceDeps,
  type PreflightBalanceDeps,
} from "../src/payment/balance.js";
import type { WrappedRunResult } from "../src/commands/call-wrapper.js";
import type { LoadedConfig } from "../src/config/index.js";
import { captureStdout } from "./test-helpers.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const solanaConfig = {
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
  accepts: { network: string; amount: string }[],
): PreflightBalanceDeps {
  return {
    ...makeBalanceDeps(rawAmount),
    parseRequirements: async () => ({ accepts }),
  };
}

function makePaymentRequiredResult(args?: {
  accepts?: { network: string; amount: string }[];
}): Extract<WrappedRunResult, { kind: "payment-required" }> {
  const accepts = args?.accepts ?? [
    {
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "100000",
    },
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
    },
  );

  await t.test(
    "throws when USDC mint is not found for Solana cluster",
    async (t) => {
      const deps = makeBalanceDeps(0n);
      deps.lookupKnownSPLToken = (() => null) as never;
      await t.rejects(
        resolveUsdcBalance(
          { network: "devnet", address: "addr", rpcUrl: "http://localhost" },
          deps,
        ),
        /No known USDC mint/,
      );
    },
  );

  await t.test(
    "throws when USDC asset is not found for EVM chain",
    async (t) => {
      const deps = makeEvmBalanceDeps(0n);
      deps.lookupKnownAsset = (() => null) as never;
      await t.rejects(
        resolveUsdcBalance(
          {
            network: "base",
            address: "0x1234000000000000000000000000000000000000",
            rpcUrl: "http://localhost",
          },
          deps,
        ),
        /No known USDC asset/,
      );
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
            {
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "100000",
            },
          ],
        }),
        makePreflightDeps(100000n, [
          {
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "100000",
          },
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
          {
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "100000",
          },
        ]),
      ),
    );
  });

  await t.test(
    "throws with the correct message when balance is insufficient",
    async (t) => {
      await t.rejects(
        checkPreflightBalance(
          solanaConfig,
          makePaymentRequiredResult(),
          makePreflightDeps(50000n, [
            {
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "100000",
            },
          ]),
        ),
        /Insufficient USDC balance \(have 0\.050000, endpoint costs 0\.100000\)/,
      );
    },
  );

  await t.test(
    "skips check when no requirement matches the wallet family",
    async (t) => {
      await t.resolves(
        checkPreflightBalance(
          solanaConfig,
          makePaymentRequiredResult(),
          makePreflightDeps(0n, [{ network: "eip155:8453", amount: "100000" }]),
        ),
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
            {
              network: "solana:mainnet",
              amount: "1000000",
            },
            {
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              amount: "200000",
            },
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
        resolveUsdcBalance: async () => ({
          address: "So11111111111111111111111111111111111111112",
          network: "solana-devnet",
          asset: "USDC",
          amount: "1.500000",
        }),
        balanceDeps: makeBalanceDeps(1_500_000n),
      });

      const stdout = await captureStdout(() =>
        cmd.handler({
          network: undefined,
          address: undefined,
          format: undefined,
        }),
      );

      t.match(stdout, /So111111/);
      t.match(stdout, /solana-devnet/);
      t.match(stdout, /USDC/);
      t.match(stdout, /1\.500000/);
    },
  );

  await t.test("outputs JSON when format is json", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveUsdcBalance: async () => ({
        address: "So11111111111111111111111111111111111111112",
        network: "solana-devnet",
        asset: "USDC",
        amount: "0.500000",
      }),
      balanceDeps: makeBalanceDeps(500000n),
    });

    const stdout = await captureStdout(() =>
      cmd.handler({ network: undefined, address: undefined, format: "json" }),
    );

    const parsed = JSON.parse(stdout) as {
      address: string;
      network: string;
      asset: string;
      amount: string;
    };
    t.equal(parsed.amount, "0.500000");
    t.equal(parsed.asset, "USDC");
  });

  await t.test(
    "uses --network and --address overrides without config",
    async (t) => {
      let capturedTarget: unknown;
      const cmd = createBalanceCommand({
        loadRequiredConfig: async () => {
          throw new Error("config should not be loaded for full override");
        },
        resolveUsdcBalance: async (target) => {
          capturedTarget = target;
          return {
            address: target.address,
            network: "solana-devnet",
            asset: "USDC",
            amount: "2.000000",
          };
        },
        balanceDeps: makeBalanceDeps(2_000_000n),
      });

      await cmd.handler({
        network: "devnet",
        address: "So11111111111111111111111111111111111111112",
        format: undefined,
      });

      t.same((capturedTarget as { network: string }).network, "devnet");
      t.same(
        (capturedTarget as { address: string }).address,
        "So11111111111111111111111111111111111111112",
      );
    },
  );

  await t.test("fails when --address is given without --network", async (t) => {
    const cmd = createBalanceCommand({
      loadRequiredConfig: async () => makeLoadedConfig(),
      resolveUsdcBalance: async () => {
        throw new Error("should not reach balance lookup");
      },
      balanceDeps: makeBalanceDeps(0n),
    });

    await t.rejects(
      cmd.handler({
        network: undefined,
        address: "So11111111111111111111111111111111111111112",
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
        resolveUsdcBalance: async () => {
          throw new Error("should not reach balance lookup");
        },
        balanceDeps: makeBalanceDeps(0n),
      });

      await t.rejects(
        cmd.handler({
          network: "base",
          address: undefined,
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
        resolveUsdcBalance: async (target) => {
          capturedTarget = target;
          return {
            address: target.address,
            network: "solana-mainnet-beta",
            asset: "USDC",
            amount: "3.000000",
          };
        },
        balanceDeps: makeBalanceDeps(3_000_000n),
      });

      await cmd.handler({
        network: "mainnet-beta",
        address: undefined,
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
      resolveUsdcBalance: async () => {
        throw new Error("RPC connection failed");
      },
      balanceDeps: makeBalanceDeps(0n),
    });

    await t.rejects(
      cmd.handler({
        network: undefined,
        address: undefined,
        format: undefined,
      }),
      /RPC connection failed/,
    );
  });
});
