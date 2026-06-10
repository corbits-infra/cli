#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import path from "node:path";
import t from "tap";
import { V2_PAYMENT_REQUIRED_HEADER } from "@faremeter/types/x402v2";
import { createCallCommand } from "../src/commands/call.js";
import { getHistoryPath, readHistoryEntry } from "../src/history/store.js";
import type { LoadedConfig } from "../src/config/index.js";
import type { PreflightBalanceDeps } from "../src/payment/balance.js";
import type { WrappedRunResult } from "../src/process/wrapped-client.js";
import { captureCombinedOutput, withTempDataHome } from "./test-helpers.js";

const resolvedConfig = {
  version: 1,
  preferences: {
    format: "table",
    apiURL: "https://api.corbits.dev",
  },
  payment: {
    network: "devnet",
    family: "solana",
    address: "So11111111111111111111111111111111111111112",
    asset: "USDC",
    rpcURL: "https://api.devnet.solana.com",
  },
  spending: {},
  activeWallet: {
    kind: "keypair",
    family: "solana",
    address: "So11111111111111111111111111111111111111112",
    path: "~/.config/solana/id.json",
    expandedPath: "/tmp/solana-id.json",
  },
} as const;

const flexRequirement = {
  scheme: "flex",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  amount: "1000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payTo: "unused",
  maxTimeoutSeconds: 60,
  extra: {
    facilitator: "Facilitator111111111111111111111111111111",
    supportedMints: ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
    splits: [
      {
        recipient: "Recipient11111111111111111111111111111111",
        bps: 10000,
      },
    ],
    minGracePeriodSlots: "12",
    decimals: 6,
  },
};

const exactRequirement = {
  scheme: "exact",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  amount: "1000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payTo: "receiver",
  maxTimeoutSeconds: 60,
  extra: { decimals: 6 },
};

function createLoadedConfig(): LoadedConfig {
  return {
    path: "/tmp/config.toml",
    config: {
      version: 1,
      preferences: {
        format: "table",
        api_url: "https://api.corbits.dev",
      },
      payment: {
        network: "devnet",
      },
      wallets: {
        solana: {
          kind: "keypair",
          address: "So11111111111111111111111111111111111111112",
          path: "~/.config/solana/id.json",
        },
      },
    },
    resolved: resolvedConfig,
  };
}

function createCompletedResult(args: {
  exitCode: number;
  status?: number | null;
  stdout: string;
  stderr?: string;
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "completed" }> {
  return {
    kind: "completed",
    exitCode: args.exitCode,
    status: args.status ?? 200,
    stdout: Buffer.from(args.stdout),
    stderr: Buffer.from(args.stderr ?? ""),
    headers: new Headers(args.headers),
  };
}

function createStreamedCompletedResult(args: {
  exitCode: number;
  status?: number | null;
  headers?: Record<string, string>;
}): Extract<WrappedRunResult, { kind: "streamed-completed" }> {
  return {
    kind: "streamed-completed",
    exitCode: args.exitCode,
    status: args.status ?? 200,
    headers: new Headers(args.headers),
  };
}

function createFlexPaymentRequiredResult(args: {
  url: string;
  requestInit: RequestInit;
}): Extract<WrappedRunResult, { kind: "payment-required" }> {
  return {
    kind: "payment-required",
    tool: "curl",
    url: args.url,
    requestInit: args.requestInit,
    response: new Response("", {
      status: 402,
      statusText: "Payment Required",
      headers: {
        [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
          JSON.stringify({
            x402Version: 2,
            resource: {
              url: args.url,
              method: args.requestInit.method ?? "GET",
            },
            accepts: [flexRequirement],
          }),
          "utf8",
        ).toString("base64"),
      },
    }),
  };
}

function createPaymentRequiredResult(args: {
  url: string;
  requestInit: RequestInit;
}): Extract<WrappedRunResult, { kind: "payment-required" }> {
  return {
    kind: "payment-required",
    tool: "curl",
    url: args.url,
    requestInit: args.requestInit,
    response: new Response(
      JSON.stringify({
        x402Version: 2,
        resource: {
          url: args.url,
          method: args.requestInit.method ?? "GET",
        },
        accepts: [exactRequirement],
      }),
      {
        status: 402,
        headers: {
          [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: {
                url: args.url,
                method: args.requestInit.method ?? "GET",
              },
              accepts: [exactRequirement],
            }),
            "utf8",
          ).toString("base64"),
        },
      },
    ),
  };
}

await t.test("call history integration", async (t) => {
  await t.test(
    "writes history and saved response for successful Flex paid calls",
    async (t) => {
      withTempDataHome(t);
      const streamOutputModes: boolean[] = [];
      let allowCreateOrTopup: boolean | undefined;

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => {
          throw new Error("should not use exact payment builder");
        },
        buildFlexPaymentRetryHeader: async (args) => {
          allowCreateOrTopup = args.allowCreateOrTopup;
          return {
            detectedVersion: 2,
            header: { name: "X-PAYMENT", value: "flex-paid" },
            paymentInfo: {
              amount: flexRequirement.amount,
              asset: flexRequirement.asset,
              assetSymbol: "USDC",
              network: flexRequirement.network,
              decimals: 6,
              sessionId: "flex-session-1",
              escrow: "Escrow1111111111111111111111111111111111",
            },
          };
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createFlexPaymentRequiredResult({
                url: "https://example.com/flex",
                requestInit: { method: "POST", body: '{"query":"flex"}' },
              })
            : (() => {
                streamOutputModes.push(args.streamOutput === true);
                return createCompletedResult({
                  exitCode: 0,
                  stdout: '{"ok":true}',
                });
              })(),
        canPromptForConfirmation: () => false,
      });

      const output = await captureCombinedOutput(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: true,
          yes: true,
          flexSession: undefined,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com/flex"],
        });
      });

      t.match(output, /\{"ok":true\}/);
      t.equal(allowCreateOrTopup, true);
      const entry = await readHistoryEntry(1);
      t.equal(entry?.record.method, "POST");
      t.equal(entry?.record.host, "example.com");
      t.equal(entry?.record.resource_path, "/flex");
      t.equal(entry?.record.amount, flexRequirement.amount);
      t.equal(entry?.record.asset, flexRequirement.asset);
      t.equal(entry?.record.asset_symbol, "USDC");
      t.equal(entry?.record.network, "solana-devnet");
      t.equal(entry?.record.wallet_kind, "keypair");
      t.equal(
        entry?.response == null
          ? undefined
          : Buffer.from(entry.response).toString("utf8"),
        '{"ok":true}',
      );
      t.same(streamOutputModes, [false]);
    },
  );

  await t.test(
    "writes a metadata history entry for successful paid calls",
    async (t) => {
      withTempDataHome(t);
      const streamOutputModes: boolean[] = [];

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 2,
          header: { name: "PAYMENT-SIGNATURE", value: "paid" },
          paymentInfo: {
            amount: "1500",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            assetSymbol: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                url: "https://exa.api.corbits.dev/search?q=solana",
                requestInit: { method: "POST", body: '{"query":"solana"}' },
              })
            : (() => {
                streamOutputModes.push(args.streamOutput === true);
                return createStreamedCompletedResult({
                  exitCode: 0,
                  headers: {
                    "payment-response": JSON.stringify({
                      success: true,
                      transaction: "sig-123",
                      network: "solana-devnet",
                    }),
                  },
                });
              })(),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: false,
        flexSession: undefined,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://exa.api.corbits.dev/search?q=solana"],
      });

      const entry = await readHistoryEntry(1);
      t.ok(entry);
      t.equal(entry?.record.method, "POST");
      t.equal(entry?.record.host, "exa.api.corbits.dev");
      t.equal(entry?.record.resource_path, "/search?q=solana");
      t.equal(entry?.record.amount, "1500");
      t.equal(
        entry?.record.asset,
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      t.equal(entry?.record.asset_symbol, "USDC");
      t.equal(entry?.record.network, "solana-devnet");
      t.equal(entry?.record.wallet_kind, "keypair");
      t.equal(entry?.record.tx_signature, "sig-123");
      t.notOk("response_path" in (entry?.record ?? {}));
      t.equal(entry?.response, undefined);
      t.same(streamOutputModes, [true]);
    },
  );

  await t.test(
    "stores the response body when --save-response is enabled",
    async (t) => {
      withTempDataHome(t);
      const streamOutputModes: boolean[] = [];

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: { name: "X-PAYMENT", value: "paid" },
          paymentInfo: {
            amount: "2000",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            assetSymbol: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                url: "https://example.com/items",
                requestInit: { method: "GET" },
              })
            : (() => {
                streamOutputModes.push(args.streamOutput === true);
                return createCompletedResult({
                  exitCode: 0,
                  stdout: '{"items":[1,2,3]}',
                });
              })(),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: true,
        yes: false,
        flexSession: undefined,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com/items"],
      });

      const entry = await readHistoryEntry(1);
      t.equal(
        entry?.response == null
          ? undefined
          : Buffer.from(entry.response).toString("utf8"),
        '{"items":[1,2,3]}',
      );
      t.equal(entry?.record.asset_symbol, "USDC");
      t.ok(entry?.record.response_path);
      if (entry?.record.response_path != null) {
        const savedResponse = await fs.readFile(
          path.resolve(
            path.dirname(getHistoryPath()),
            entry.record.response_path,
          ),
          "utf8",
        );
        t.equal(savedResponse, '{"items":[1,2,3]}');
      }
      t.same(streamOutputModes, [false]);
    },
  );

  await t.test(
    "stores raw response bytes when --save-response is enabled",
    async (t) => {
      withTempDataHome(t);

      const binaryResponse = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: { name: "X-PAYMENT", value: "paid" },
          paymentInfo: {
            amount: "2000",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            assetSymbol: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                url: "https://example.com/binary",
                requestInit: { method: "GET" },
              })
            : {
                kind: "completed",
                exitCode: 0,
                status: 200,
                stdout: binaryResponse,
                stderr: new Uint8Array(),
                headers: new Headers(),
              },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      await call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: true,
        yes: false,
        flexSession: undefined,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com/binary"],
      });

      const entry = await readHistoryEntry(1);
      t.same(entry?.response, binaryResponse);
      if (entry?.record.response_path != null) {
        const savedResponse = await fs.readFile(
          path.resolve(
            path.dirname(getHistoryPath()),
            entry.record.response_path,
          ),
        );
        t.same(savedResponse, binaryResponse);
      }
    },
  );

  await t.test(
    "warns on history write failure without changing success behavior",
    async (t) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: { name: "X-PAYMENT", value: "paid" },
          paymentInfo: {
            amount: "1000",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            assetSymbol: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        appendHistoryRecord: async () => {
          throw new Error("disk full");
        },
        runWrappedClient: async (args) =>
          args.extraHeader == null
            ? createPaymentRequiredResult({
                url: "https://example.com/resource",
                requestInit: { method: "GET" },
              })
            : createCompletedResult({
                exitCode: 0,
                stdout: "paid response",
              }),
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const output = await captureCombinedOutput(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          flexSession: undefined,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com/resource"],
        });
      });

      t.match(output, /paid response/);
      t.match(
        output,
        /Warning: paid call succeeded, but history could not be persisted: disk full/,
      );
      t.equal(process.exitCode, 0);
    },
  );

  await t.test(
    "does not persist a history entry when the paid retry exits non-zero",
    async (t) => {
      withTempDataHome(t);
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      t.teardown(() => {
        process.exitCode = priorExitCode;
      });

      const call = createCallCommand({
        loadRequiredConfig: async () => createLoadedConfig(),
        buildPaymentRetryHeader: async () => ({
          detectedVersion: 1,
          header: { name: "X-PAYMENT", value: "paid" },
          paymentInfo: {
            amount: "2500",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            assetSymbol: "USDC",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          },
        }),
        runWrappedClient: async (args) => {
          if (args.extraHeader == null) {
            return createPaymentRequiredResult({
              url: "https://example.com/fail",
              requestInit: { method: "GET" },
            });
          }

          return createCompletedResult({
            exitCode: 22,
            status: 500,
            stdout: '{"error":"server failed"}',
          });
        },
        checkPreflightBalance: async () => void 0,
        preflightBalanceDeps: {} as PreflightBalanceDeps,
      });

      const output = await captureCombinedOutput(async () => {
        await call.handler({
          inspect: false,
          paymentInfo: false,
          saveResponse: false,
          yes: false,
          flexSession: undefined,
          asset: undefined,
          format: undefined,
          tool: "curl",
          args: ["https://example.com/fail"],
        });
      });

      const entry = await readHistoryEntry(1);
      t.match(output, /\{"error":"server failed"\}/);
      t.equal(process.exitCode, 22);
      t.equal(entry, null);
    },
  );
});
