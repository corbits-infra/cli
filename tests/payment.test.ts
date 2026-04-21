#!/usr/bin/env pnpm tsx

import t from "tap";
import type { ChainInfo } from "@faremeter/types/evm";
import {
  V2_PAYMENT_HEADER,
  V2_PAYMENT_REQUIRED_HEADER,
} from "@faremeter/types/x402v2";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { captureStdout } from "./test-helpers.js";
import {
  getPaymentOptions,
  printPaymentOptions,
} from "../src/payment/options.js";
import {
  createBuildPaymentHandler,
  createBuildPaymentRetryHeader,
  extractPaymentResponseTransaction,
} from "../src/payment/signer.js";
import { createBuildOwsPaymentHandler } from "../src/payment/ows.js";

function createSolanaKeypairConfig() {
  return {
    version: 1 as const,
    preferences: {
      format: "table" as const,
      apiUrl: "https://api.corbits.dev",
    },
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
}

function createEvmKeypairConfig() {
  return {
    version: 1 as const,
    preferences: {
      format: "table" as const,
      apiUrl: "https://api.corbits.dev",
    },
    payment: {
      network: "base" as const,
      family: "evm" as const,
      address: "0x1234000000000000000000000000000000000000",
      asset: "USDC",
      rpcUrl: "https://mainnet.base.org",
    },
    activeWallet: {
      kind: "keypair" as const,
      family: "evm" as const,
      address: "0x1234000000000000000000000000000000000000",
      path: "~/.config/evm/id.txt",
      expandedPath: "/tmp/evm-id.txt",
    },
  };
}

function createSolanaOwsConfig() {
  return {
    version: 1 as const,
    preferences: {
      format: "table" as const,
      apiUrl: "https://api.corbits.dev",
    },
    payment: {
      network: "devnet" as const,
      family: "solana" as const,
      address: "So11111111111111111111111111111111111111112",
      asset: "USDC",
      rpcUrl: "https://api.devnet.solana.com",
    },
    activeWallet: {
      kind: "ows" as const,
      family: "solana" as const,
      address: "So11111111111111111111111111111111111111112",
      walletId: "primary-solana",
    },
  };
}

function createEvmOwsConfig() {
  return {
    version: 1 as const,
    preferences: {
      format: "table" as const,
      apiUrl: "https://api.corbits.dev",
    },
    payment: {
      network: "base" as const,
      family: "evm" as const,
      address: "0x1234000000000000000000000000000000000000",
      asset: "USDC",
      rpcUrl: "https://mainnet.base.org",
    },
    activeWallet: {
      kind: "ows" as const,
      family: "evm" as const,
      address: "0x1234000000000000000000000000000000000000",
      walletId: "primary-evm",
    },
  };
}

await t.test("payment signer", async (t) => {
  await t.test(
    "builds payment option records from accepted requirements",
    (t) => {
      const options = getPaymentOptions([
        {
          scheme: "exact",
          network: "solana-mainnet-beta",
          amount: "10000",
          asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
          extra: { decimals: 6 },
        },
        {
          scheme: "exact",
          network: "base",
          amount: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
          extra: { decimals: 6 },
        },
        {
          scheme: "exact",
          network: "solana:unknown",
          amount: "7",
          asset: "unknown-asset",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
        },
      ]);

      t.same(options, [
        {
          asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          symbol: "USDT",
          amount: "10000",
          decimals: 6,
          formattedAmount: "0.010000",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          scheme: "exact",
        },
        {
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          symbol: "USDC",
          amount: "10000",
          decimals: 6,
          formattedAmount: "0.010000",
          network: "eip155:8453",
          scheme: "exact",
        },
        {
          asset: "unknown-asset",
          symbol: null,
          amount: "7",
          decimals: null,
          formattedAmount: "7",
          network: "solana:unknown",
          scheme: "exact",
        },
      ]);
      t.end();
    },
  );

  await t.test("prints payment options in table, json, and yaml", async (t) => {
    const options = getPaymentOptions([
      {
        scheme: "exact",
        network: "solana-mainnet-beta",
        amount: "10000",
        asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        payTo: "receiver",
        maxTimeoutSeconds: 60,
        extra: { decimals: 6 },
      },
    ]);

    const table = await captureStdout(() =>
      printPaymentOptions("table", options),
    );
    t.match(table, /Asset/);
    t.match(table, /USDT/);
    t.match(table, /0\.010000/);
    t.match(table, /solana-mainnet-beta/);

    const json = await captureStdout(() =>
      printPaymentOptions("json", options),
    );
    t.same(JSON.parse(json), [
      {
        asset: "USDT",
        address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        amount: "0.010000",
        network: "solana-mainnet-beta",
      },
    ]);

    const yaml = await captureStdout(() =>
      printPaymentOptions("yaml", options),
    );
    t.match(yaml, /asset: USDT/);
    t.match(yaml, /amount: "0\.010000"/);
    t.end();
  });

  await t.test(
    "formats known Solana asset amounts for display without challenge decimals",
    async (t) => {
      const options = getPaymentOptions([
        {
          scheme: "exact",
          network: "solana-mainnet-beta",
          amount: "10000",
          asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
        },
      ]);

      const json = await captureStdout(() =>
        printPaymentOptions("json", options),
      );
      t.same(JSON.parse(json), [
        {
          asset: "USDT",
          address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          amount: "0.010000",
          network: "solana-mainnet-beta",
        },
      ]);
    },
  );

  await t.test(
    "formats known EVM asset amounts and networks for display",
    async (t) => {
      const options = getPaymentOptions([
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
        },
        {
          scheme: "exact",
          network: "eip155:143",
          amount: "10000",
          asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
        },
      ]);

      const json = await captureStdout(() =>
        printPaymentOptions("json", options),
      );
      t.same(JSON.parse(json), [
        {
          asset: "USDC",
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "0.010000",
          network: "base",
        },
        {
          asset: "USDC",
          address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
          amount: "0.010000",
          network: "monad",
        },
      ]);
    },
  );

  await t.test(
    "extracts settled transaction ids from payment response headers",
    async (t) => {
      t.equal(
        extractPaymentResponseTransaction(
          new Headers({
            "payment-response": JSON.stringify({
              success: true,
              transaction: "sig-json",
              network: "solana-mainnet-beta",
              payer: "payer",
            }),
          }),
        ),
        "sig-json",
      );

      t.equal(
        extractPaymentResponseTransaction(
          new Headers({
            "x-payment-response": Buffer.from(
              JSON.stringify({
                success: true,
                txHash: "sig-b64",
                networkId: "solana-mainnet-beta",
                payer: "payer",
              }),
              "utf8",
            ).toString("base64"),
          }),
        ),
        "sig-b64",
      );
    },
  );

  await t.test(
    "builds X-PAYMENT retry headers directly from handlers",
    async (t) => {
      let seenContext: unknown;
      let seenAccepts: unknown[] | undefined;
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async () => ({
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          handler: async (context, accepts) => {
            const supportedAccept = accepts.find((accept) =>
              accept.network.startsWith("solana:"),
            );
            if (supportedAccept == null) {
              throw new Error("expected a supported payment requirement");
            }
            seenContext = context;
            seenAccepts = accepts;
            return [
              {
                requirements: supportedAccept,
                exec: async () => ({
                  payload: {
                    signature: "0xpaid",
                  },
                }),
              },
            ];
          },
        }),
      });

      const supportedAccept = {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        maxAmountRequired: "1000",
        resource: "https://example.com",
        description: "pay",
        payTo: "receiver",
        maxTimeoutSeconds: 60,
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      };
      const unsupportedAccept = {
        ...supportedAccept,
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      };

      const header = await buildPaymentRetryHeader({
        config: createSolanaKeypairConfig(),
        response: new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [unsupportedAccept, supportedAccept],
          }),
          { status: 402, statusText: "Payment Required" },
        ),
        url: "https://example.com",
        requestInit: {
          method: "POST",
          body: '{"ok":true}',
        },
      });

      t.same(header, {
        detectedVersion: 1,
        header: {
          name: "X-PAYMENT",
          value: Buffer.from(
            JSON.stringify({
              x402Version: 1,
              scheme: "exact",
              network: "solana-devnet",
              asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              payload: { signature: "0xpaid" },
            }),
            "utf8",
          ).toString("base64"),
        },
        paymentInfo: {
          amount: "1000",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        },
      });
      t.type((seenContext as { request?: unknown }).request, Request);
      const request = (seenContext as { request: Request }).request;
      t.equal(request.url, "https://example.com/");
      t.equal(request.method, "POST");
      t.equal(await request.text(), '{"ok":true}');
      t.same(seenAccepts, [
        {
          scheme: "exact",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          amount: "1000",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
        },
      ]);
    },
  );

  await t.test(
    "builds X-PAYMENT retry headers from PAYMENT-REQUIRED header challenges",
    async (t) => {
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async () => ({
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          handler: async (_context, accepts) => {
            const firstAccept = accepts[0];
            if (firstAccept == null) {
              throw new Error("expected a supported payment requirement");
            }

            return [
              {
                requirements: firstAccept,
                exec: async () => ({
                  payload: {
                    signature: "0xpaid-from-header",
                  },
                }),
              },
            ];
          },
        }),
      });

      const header = await buildPaymentRetryHeader({
        config: createSolanaKeypairConfig(),
        response: new Response("", {
          status: 402,
          statusText: "Payment Required",
          headers: {
            [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
              JSON.stringify({
                x402Version: 2,
                resource: {
                  url: "https://example.com",
                  method: "POST",
                },
                accepts: [
                  {
                    scheme: "exact",
                    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                    amount: "1000",
                    payTo: "receiver",
                    maxTimeoutSeconds: 60,
                    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                    extra: {
                      decimals: 6,
                    },
                  },
                ],
                extensions: {
                  bazaar: {
                    info: {
                      input: { type: "http", bodyType: "json", body: {} },
                    },
                  },
                },
              }),
              "utf8",
            ).toString("base64"),
          },
        }),
        url: "https://example.com",
        requestInit: {
          method: "POST",
          body: '{"ok":true}',
        },
      });

      t.same(header, {
        detectedVersion: 2,
        header: {
          name: V2_PAYMENT_HEADER,
          value: Buffer.from(
            JSON.stringify({
              x402Version: 2,
              accepted: {
                scheme: "exact",
                network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                amount: "1000",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                extra: {
                  decimals: 6,
                },
              },
              payload: { signature: "0xpaid-from-header" },
              resource: {
                url: "https://example.com",
                method: "POST",
              },
            }),
            "utf8",
          ).toString("base64"),
        },
        paymentInfo: {
          amount: "1000",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          decimals: 6,
        },
      });
    },
  );

  await t.test(
    "selects the requested asset on the active payment network",
    async (t) => {
      let seenRequirementSymbol: string | null | undefined;
      let seenAccepts: unknown[] | undefined;
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async (_config, requirement) => {
          seenRequirementSymbol = requirement?.symbol;
          return {
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            handler: async (_context, accepts) => {
              seenAccepts = accepts;
              const firstAccept = accepts[0];
              if (firstAccept == null) {
                throw new Error("expected a supported payment requirement");
              }

              return [
                {
                  requirements: firstAccept,
                  exec: async () => ({
                    payload: {
                      signature: "0xpaid-usdt",
                    },
                  }),
                },
              ];
            },
          };
        },
      });

      const header = await buildPaymentRetryHeader({
        config: {
          ...createSolanaKeypairConfig(),
          payment: {
            ...createSolanaKeypairConfig().payment,
            asset: "USDT",
            network: "mainnet-beta",
            rpcUrl: "https://api.mainnet-beta.solana.com",
          },
        },
        response: new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "solana-mainnet-beta",
                maxAmountRequired: "10000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                extra: { decimals: 6 },
              },
              {
                scheme: "exact",
                network: "solana-mainnet-beta",
                maxAmountRequired: "10000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                extra: { decimals: 6 },
              },
            ],
          }),
          { status: 402, statusText: "Payment Required" },
        ),
        url: "https://example.com",
        requestInit: { method: "GET" },
      });

      t.equal(seenRequirementSymbol, "USDT");
      t.same(seenAccepts, [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: "10000",
          asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
          extra: { decimals: 6 },
        },
      ]);
      t.equal(
        header.paymentInfo.asset,
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      );
    },
  );

  await t.test(
    "reports duplicate requirements for the same asset as ambiguous",
    async (t) => {
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async () => ({
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          handler: async () => [],
        }),
      });

      await t.rejects(
        buildPaymentRetryHeader({
          config: {
            ...createSolanaKeypairConfig(),
            payment: {
              ...createSolanaKeypairConfig().payment,
              asset: "USDT",
              network: "mainnet-beta",
              rpcUrl: "https://api.mainnet-beta.solana.com",
            },
          },
          response: new Response(
            JSON.stringify({
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "solana-mainnet-beta",
                  maxAmountRequired: "10000",
                  resource: "https://example.com",
                  description: "pay",
                  payTo: "receiver-a",
                  maxTimeoutSeconds: 60,
                  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                  extra: { decimals: 6 },
                },
                {
                  scheme: "exact",
                  network: "solana-mainnet-beta",
                  maxAmountRequired: "10000",
                  resource: "https://example.com",
                  description: "pay",
                  payTo: "receiver-b",
                  maxTimeoutSeconds: 60,
                  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                  extra: { decimals: 6 },
                },
              ],
            }),
            { status: 402, statusText: "Payment Required" },
          ),
          url: "https://example.com",
          requestInit: { method: "GET" },
        }),
        /asset USDT is ambiguous on active payment network mainnet-beta; matching requirements: .*payTo=receiver-a.*payTo=receiver-b/s,
      );
    },
  );

  await t.test(
    "ignores exact duplicate requirements for the same asset",
    async (t) => {
      let seenAccepts: unknown[] | undefined;
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async () => ({
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          handler: async (_context, accepts) => {
            seenAccepts = accepts;
            const firstAccept = accepts[0];
            if (firstAccept == null) {
              throw new Error("expected a supported payment requirement");
            }

            return [
              {
                requirements: firstAccept,
                exec: async () => ({
                  payload: {
                    signature: "0xpaid-usdt",
                  },
                }),
              },
            ];
          },
        }),
      });

      const header = await buildPaymentRetryHeader({
        config: {
          ...createSolanaKeypairConfig(),
          payment: {
            ...createSolanaKeypairConfig().payment,
            asset: "USDT",
            network: "mainnet-beta",
            rpcUrl: "https://api.mainnet-beta.solana.com",
          },
        },
        response: new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "solana-mainnet-beta",
                maxAmountRequired: "10000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                extra: { decimals: 6 },
              },
              {
                scheme: "exact",
                network: "solana-mainnet-beta",
                maxAmountRequired: "10000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                extra: { decimals: 6 },
              },
            ],
          }),
          { status: 402, statusText: "Payment Required" },
        ),
        url: "https://example.com",
        requestInit: { method: "GET" },
      });

      t.same(seenAccepts, [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: "10000",
          asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
          payTo: "receiver",
          maxTimeoutSeconds: 60,
          extra: { decimals: 6 },
        },
      ]);
      t.equal(
        header.paymentInfo.asset,
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      );
    },
  );

  await t.test(
    "reports accepted assets when the default asset is not offered",
    async (t) => {
      const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
        buildPaymentHandler: async () => ({
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          handler: async () => [],
        }),
      });

      await t.rejects(
        buildPaymentRetryHeader({
          config: {
            ...createSolanaKeypairConfig(),
            payment: {
              ...createSolanaKeypairConfig().payment,
              network: "mainnet-beta",
              rpcUrl: "https://api.mainnet-beta.solana.com",
            },
          },
          response: new Response(
            JSON.stringify({
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "solana-mainnet-beta",
                  maxAmountRequired: "10000",
                  resource: "https://example.com",
                  description: "pay",
                  payTo: "receiver",
                  maxTimeoutSeconds: 60,
                  asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                  extra: { decimals: 6 },
                },
                {
                  scheme: "exact",
                  network: "solana-mainnet-beta",
                  maxAmountRequired: "10000",
                  resource: "https://example.com",
                  description: "pay",
                  payTo: "receiver",
                  maxTimeoutSeconds: 60,
                  asset: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
                  extra: { decimals: 6 },
                },
              ],
            }),
            { status: 402, statusText: "Payment Required" },
          ),
          url: "https://example.com",
          requestInit: { method: "GET" },
        }),
        /active payment network mainnet-beta does not offer asset USDC; accepted assets: USDT .* PYUSD/s,
      );
    },
  );

  await t.test("rejects unsupported payment requirements", async (t) => {
    const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
      buildPaymentHandler: async () => ({
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        handler: async () => [],
      }),
    });

    await t.rejects(
      buildPaymentRetryHeader({
        config: createSolanaKeypairConfig(),
        response: new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "eip155:8453",
                maxAmountRequired: "1000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              },
            ],
          }),
          { status: 402, statusText: "Payment Required" },
        ),
        url: "https://example.com",
        requestInit: {
          method: "GET",
        },
      }),
      /server only offered EVM x402 payment requirements .* active payment network is devnet/,
    );
  });

  await t.test("reports when an endpoint is Solana-only", async (t) => {
    const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
      buildPaymentHandler: async () => ({
        network: "eip155:8453",
        handler: async () => [],
      }),
    });

    await t.rejects(
      buildPaymentRetryHeader({
        config: createEvmKeypairConfig(),
        response: new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "solana-mainnet-beta",
                maxAmountRequired: "1000",
                resource: "https://example.com",
                description: "pay",
                payTo: "receiver",
                maxTimeoutSeconds: 60,
                asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              },
            ],
          }),
          { status: 402, statusText: "Payment Required" },
        ),
        url: "https://example.com",
        requestInit: {
          method: "GET",
        },
      }),
      /server only offered Solana x402 payment requirements .* active payment network is base/,
    );
  });

  await t.test("rejects unsupported signer networks", async (t) => {
    const buildPaymentHandler = createBuildPaymentHandler({
      readTextFile: async () => "[]",
      buildOwsPaymentHandler: async () => {
        throw new Error("should not build OWS handler");
      },
      createSolanaLocalWallet: async () => {
        throw new Error("should not build a Solana wallet");
      },
      createEvmLocalWallet: async () => {
        throw new Error("should not build an EVM wallet");
      },
      createSolanaPaymentHandler: (() => {
        throw new Error("should not build a Solana payment handler");
      }) as never,
      createEvmPaymentHandler: (() => {
        throw new Error("should not build an EVM payment handler");
      }) as never,
      createConnection: () => {
        throw new Error("should not create a connection");
      },
      lookupKnownSPLToken: (() => undefined) as never,
      clusterToCAIP2: (() => ({ caip2: "" })) as never,
      lookupKnownAsset: (() => undefined) as never,
      lookupX402Network: (() => "") as never,
    });

    const config = {
      ...createSolanaKeypairConfig(),
      payment: {
        ...createSolanaKeypairConfig().payment,
        network: "localnet" as const,
      },
    };

    await t.rejects(
      () => buildPaymentHandler(config),
      /do not support network localnet/,
    );
  });

  await t.test("uses the expanded Solana keypair path", async (t) => {
    const keypair = Keypair.generate();
    let readPath: string | undefined;
    let seenWalletArgs:
      | {
          network: string;
          publicKey: string;
        }
      | undefined;
    let seenPaymentHandlerOptions: unknown;

    const buildPaymentHandler = createBuildPaymentHandler({
      readTextFile: async (filePath) => {
        readPath = filePath;
        return JSON.stringify(Array.from(keypair.secretKey));
      },
      buildOwsPaymentHandler: async () => {
        throw new Error("should not build OWS handler");
      },
      createSolanaLocalWallet: async (network, loadedKeypair) => {
        seenWalletArgs = {
          network,
          publicKey: loadedKeypair.publicKey.toBase58(),
        };
        return {
          network,
          publicKey: loadedKeypair.publicKey,
          partiallySignTransaction: async (tx) => tx,
          updateTransaction: async (tx) => tx,
        };
      },
      createEvmLocalWallet: async () => {
        throw new Error("should not build an EVM wallet");
      },
      createSolanaPaymentHandler: ((...args: unknown[]) => {
        seenPaymentHandlerOptions = args[3];
        return (async () => []) as never;
      }) as never,
      createEvmPaymentHandler: (() => {
        throw new Error("should not build an EVM payment handler");
      }) as never,
      createConnection: (() => ({})) as never,
      lookupKnownSPLToken: (() => ({
        address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        name: "USDC",
      })) as never,
      clusterToCAIP2: (() => ({
        caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      })) as never,
      lookupKnownAsset: (() => undefined) as never,
      lookupX402Network: (() => "") as never,
    });

    const built = await buildPaymentHandler(createSolanaKeypairConfig());

    t.equal(readPath, "/tmp/id.json");
    t.same(seenWalletArgs, {
      network: "devnet",
      publicKey: keypair.publicKey.toBase58(),
    });
    t.same(seenPaymentHandlerOptions, {
      token: { allowOwnerOffCurve: true },
    });
    t.equal(built.network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  await t.test(
    "uses the expanded EVM key path and normalizes the prefix",
    async (t) => {
      let readPath: string | undefined;
      let seenWalletArgs:
        | {
            chainId: number;
            chainName: string;
            privateKey: string;
          }
        | undefined;

      const buildPaymentHandler = createBuildPaymentHandler({
        readTextFile: async (filePath) => {
          readPath = filePath;
          return "11".repeat(32);
        },
        buildOwsPaymentHandler: async () => {
          throw new Error("should not build OWS handler");
        },
        createSolanaLocalWallet: async () => {
          throw new Error("should not build a Solana wallet");
        },
        createEvmLocalWallet: (async (chain: ChainInfo, privateKey: string) => {
          seenWalletArgs = {
            chainId: chain.id,
            chainName: chain.name,
            privateKey,
          };
          return {
            chain,
            address: "0x1234000000000000000000000000000000000000",
            account: {
              signTypedData: async () =>
                "0xabc1230000000000000000000000000000000000000000000000000000000000",
            },
          };
        }) as never,
        createSolanaPaymentHandler: (() => {
          throw new Error("should not build a Solana payment handler");
        }) as never,
        createEvmPaymentHandler: (() => (async () => []) as never) as never,
        createConnection: (() => {
          throw new Error("should not create a Solana connection");
        }) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => ({
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          contractName: "USD Coin",
        })) as never,
        lookupX402Network: (() => "eip155:8453") as never,
      });

      const built = await buildPaymentHandler(createEvmKeypairConfig());

      t.equal(readPath, "/tmp/evm-id.txt");
      t.same(seenWalletArgs, {
        chainId: 8453,
        chainName: "Base",
        privateKey:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      });
      t.equal(built.network, "eip155:8453");
    },
  );
});

await t.test("OWS payment handlers", async (t) => {
  await t.test(
    "builds Solana payment handlers without passphrase handling",
    async (t) => {
      let signTransactionArgs: unknown[] | undefined;
      let capturedWallet:
        | {
            publicKey: PublicKey;
            partiallySignTransaction(
              tx: VersionedTransaction,
            ): Promise<VersionedTransaction>;
          }
        | undefined;
      let seenPaymentHandlerOptions: unknown;

      const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
        getWallet: (() => ({
          id: "wallet-solana-id",
          name: "primary-solana",
          accounts: [
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "So11111111111111111111111111111111111111112",
              derivationPath: "m/44'/501'/0'/0'",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: ((...args: unknown[]) => {
          signTransactionArgs = args;
          return { signature: "11".repeat(64) };
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign typed data for Solana");
        }) as never,
        createConnection: (() => ({})) as never,
        lookupKnownSPLToken: (() => ({
          address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          name: "USDC",
        })) as never,
        clusterToCAIP2: (() => ({
          caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: ((
          wallet: unknown,
          _mint: unknown,
          _connection: unknown,
          options: unknown,
        ) => {
          capturedWallet = wallet as typeof capturedWallet;
          seenPaymentHandlerOptions = options;
          return (async () => []) as never;
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error("should not create an EVM handler for Solana");
        }) as never,
      });

      const built = await buildOwsPaymentHandler(createSolanaOwsConfig());

      t.equal(built.network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
      t.same(seenPaymentHandlerOptions, {
        token: { allowOwnerOffCurve: true },
      });

      if (capturedWallet == null) {
        throw new Error("expected Solana wallet to be captured");
      }

      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: capturedWallet.publicKey,
          recentBlockhash: "11111111111111111111111111111111",
          instructions: [],
        }).compileToV0Message(),
      );
      const unsignedTxHex = Buffer.from(tx.serialize()).toString("hex");
      await capturedWallet.partiallySignTransaction(tx);
      t.same(signTransactionArgs, [
        "wallet-solana-id",
        "solana",
        unsignedTxHex,
      ]);
      const signature = tx.signatures[0];
      t.equal(signature?.length, 64);
      if (signature == null) {
        throw new Error("expected Solana signature to be attached");
      }
      t.same([...signature], new Array(64).fill(0x11));
    },
  );

  await t.test(
    "selects the matching account from multi-account OWS wallets",
    async (t) => {
      let capturedWallet:
        | {
            publicKey: PublicKey;
          }
        | undefined;

      const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
        getWallet: (() => ({
          id: "wallet-solana-id",
          name: "primary-solana",
          accounts: [
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "8GUFsPwiE7npjTXujUua5yEuEm1cPefB8MpWkLJ1Fvr6",
              derivationPath: "m/44'/501'/0'/0'",
            },
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "So11111111111111111111111111111111111111112",
              derivationPath: "m/44'/501'/0'/1'",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign in this test");
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign typed data for Solana");
        }) as never,
        createConnection: (() => ({})) as never,
        lookupKnownSPLToken: (() => ({
          address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          name: "USDC",
        })) as never,
        clusterToCAIP2: (() => ({
          caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: ((wallet: unknown) => {
          capturedWallet = wallet as typeof capturedWallet;
          return (async () => []) as never;
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error("should not create an EVM handler for Solana");
        }) as never,
      });

      await buildOwsPaymentHandler(createSolanaOwsConfig());

      t.equal(
        capturedWallet?.publicKey.toBase58(),
        "So11111111111111111111111111111111111111112",
      );
    },
  );

  await t.test(
    "builds EVM payment handlers without passphrase handling",
    async (t) => {
      let capturedWallet:
        | {
            account: {
              signTypedData(params: unknown): Promise<string>;
            };
          }
        | undefined;
      let signTypedDataArgs: unknown[] | undefined;

      const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
        getWallet: (() => ({
          id: "wallet-evm-id",
          name: "primary-evm",
          accounts: [
            {
              chainId: "eip155:8453",
              address: "0x1234000000000000000000000000000000000000",
              derivationPath: "m/44'/60'/0'/0/0",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign Solana transactions for EVM");
        }) as never,
        signTypedData: ((...args: unknown[]) => {
          signTypedDataArgs = args;
          return { signature: "abc123" };
        }) as never,
        createConnection: (() => ({})) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => ({
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          contractName: "USD Coin",
        })) as never,
        lookupX402Network: (() => "eip155:8453") as never,
        createSolanaPaymentHandler: (() => {
          throw new Error("should not create a Solana handler for EVM");
        }) as never,
        createEvmPaymentHandler: ((wallet: unknown) => {
          capturedWallet = wallet as typeof capturedWallet;
          return (async () => []) as never;
        }) as never,
      });

      const built = await buildOwsPaymentHandler(createEvmOwsConfig());

      t.equal(built.network, "eip155:8453");

      if (capturedWallet == null) {
        throw new Error("expected EVM wallet to be captured");
      }

      const signature = await capturedWallet.account.signTypedData({
        domain: { chainId: 8453 },
        types: {},
        primaryType: "TransferWithAuthorization",
        message: { value: 1n },
      });

      t.equal(signature, "0xabc123");
      t.equal(signTypedDataArgs?.length, 3);
      t.equal(signTypedDataArgs?.[0], "wallet-evm-id");
      t.equal(signTypedDataArgs?.[1], "base");
      t.match(String(signTypedDataArgs?.[2]), /EIP712Domain/);
      t.match(String(signTypedDataArgs?.[2]), /"value":"1"/);
    },
  );

  await t.test(
    "rejects Solana OWS wallets with a mismatched address",
    async (t) => {
      const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
        getWallet: (() => ({
          id: "wallet-solana-id",
          name: "primary-solana",
          accounts: [
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "8GUFsPwiE7npjTXujUua5yEuEm1cPefB8MpWkLJ1Fvr6",
              derivationPath: "m/44'/501'/0'/0'",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign for mismatched Solana wallets");
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign typed data for Solana");
        }) as never,
        createConnection: (() => ({})) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: (() => {
          throw new Error(
            "should not create a Solana handler for mismatched wallets",
          );
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error("should not create an EVM handler for Solana");
        }) as never,
      });

      await t.rejects(
        () => buildOwsPaymentHandler(createSolanaOwsConfig()),
        /does not match any solana account in OWS wallet/,
      );
    },
  );

  await t.test(
    "rejects EVM OWS wallets with a mismatched address",
    async (t) => {
      const buildOwsPaymentHandler = createBuildOwsPaymentHandler({
        getWallet: (() => ({
          id: "wallet-evm-id",
          name: "primary-evm",
          accounts: [
            {
              chainId: "eip155:8453",
              address: "0x9999000000000000000000000000000000000000",
              derivationPath: "m/44'/60'/0'/0/0",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign Solana transactions for EVM");
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign for mismatched EVM wallets");
        }) as never,
        createConnection: (() => ({})) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: (() => {
          throw new Error("should not create a Solana handler for EVM");
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error(
            "should not create an EVM handler for mismatched wallets",
          );
        }) as never,
      });

      await t.rejects(
        () => buildOwsPaymentHandler(createEvmOwsConfig()),
        /does not match any evm account in OWS wallet/,
      );
    },
  );
});
