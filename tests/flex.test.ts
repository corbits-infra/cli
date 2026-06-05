#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import t from "tap";
import { X_PAYMENT_HEADER } from "@faremeter/types/x402";
import {
  V2_PAYMENT_HEADER,
  V2_PAYMENT_REQUIRED_HEADER,
} from "@faremeter/types/x402v2";

import { createCallCommand } from "../src/commands/call.js";
import {
  filterEligibleTopupSessionViews,
  parsePositiveDisplayAmount,
  printTopupResult,
  statusDisplayRows,
  statusRows,
} from "../src/commands/flex.js";
import {
  createFlexSessionRecord,
  findMatchingFlexSessions,
  readFlexSessionStore,
  selectFlexRequirement,
  type FlexSessionRecord,
  type FlexSessionRuntimeView,
  writeFlexSessionStore,
} from "../src/payment/flex.js";
import {
  buildFlexPaymentHeader,
  getFlexEscrowTimeoutSlots,
} from "../src/payment/flex-solana.js";
import {
  captureCombinedOutput,
  captureStderr,
  captureStdout,
} from "./test-helpers.js";

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

function createPaymentRequiredResponse(): Response {
  return new Response("", {
    status: 402,
    statusText: "Payment Required",
    headers: {
      [V2_PAYMENT_REQUIRED_HEADER]: Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: {
            url: "https://example.com/flex",
          },
          accepts: [flexRequirement],
        }),
        "utf8",
      ).toString("base64"),
    },
  });
}

function createV1PaymentRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "flex",
          network: "solana-devnet",
          maxAmountRequired: flexRequirement.amount,
          resource: "https://example.com/flex",
          description: "solana-devnet-USDC",
          mimeType: "",
          payTo: flexRequirement.payTo,
          maxTimeoutSeconds: flexRequirement.maxTimeoutSeconds,
          asset: flexRequirement.asset,
          extra: flexRequirement.extra,
        },
      ],
      error: "",
    }),
    {
      status: 402,
      statusText: "Payment Required",
    },
  );
}

function decodeHeaderPayload(header: { value: string }): unknown {
  return JSON.parse(Buffer.from(header.value, "base64").toString("utf8"));
}

await t.test(
  "selects Flex requirements by active Solana network and asset",
  (t) => {
    const selection = selectFlexRequirement({
      accepts: [flexRequirement],
      config: resolvedConfig,
    });

    t.equal(selection.kind, "selected");
    if (selection.kind === "selected") {
      t.equal(selection.selected.scheme, "flex");
      t.equal(
        selection.selected.facilitator,
        "Facilitator111111111111111111111111111111",
      );
      t.equal(selection.selected.minGracePeriodSlots, 12n);
    }
    t.end();
  },
);

await t.test("accepts documented @faremeter/flex scheme alias", (t) => {
  const selection = selectFlexRequirement({
    accepts: [{ ...flexRequirement, scheme: "@faremeter/flex" }],
    config: resolvedConfig,
  });

  t.equal(selection.kind, "selected");
  if (selection.kind === "selected") {
    t.equal(selection.selected.scheme, "flex");
    t.equal(selection.selected.requirement.scheme, "@faremeter/flex");
  }
  t.end();
});

await t.test("builds v2 Flex payment header for v2 challenges", (t) => {
  const header = buildFlexPaymentHeader({
    detectedVersion: 2,
    requirements: flexRequirement,
    payload: { authorization: "session-signature" },
    resource: { url: "https://example.com/flex" },
  });

  t.equal(header.name, V2_PAYMENT_HEADER);
  t.same(decodeHeaderPayload(header), {
    x402Version: 2,
    accepted: flexRequirement,
    payload: { authorization: "session-signature" },
    resource: { url: "https://example.com/flex" },
  });
  t.end();
});

await t.test("builds legacy Flex payment header for v1 challenges", (t) => {
  const header = buildFlexPaymentHeader({
    detectedVersion: 1,
    requirements: flexRequirement,
    payload: { authorization: "session-signature" },
    resource: { url: "https://example.com/flex" },
  });

  t.equal(header.name, X_PAYMENT_HEADER);
  t.same(decodeHeaderPayload(header), {
    x402Version: 1,
    scheme: "flex",
    network: "solana-devnet",
    asset: flexRequirement.asset,
    payload: { authorization: "session-signature" },
  });
  t.end();
});

await t.test(
  "chooses escrow timeouts that satisfy session grace constraints",
  (t) => {
    const defaultTimeouts = getFlexEscrowTimeoutSlots(150n);
    t.ok(
      defaultTimeouts.refundTimeoutSlots > 150n,
      "refund timeout must exceed revocation grace",
    );
    t.ok(
      defaultTimeouts.deadmanTimeoutSlots >=
        defaultTimeouts.refundTimeoutSlots * 2n,
      "deadman timeout must be at least twice refund timeout",
    );

    const longGraceTimeouts = getFlexEscrowTimeoutSlots(500n);
    t.equal(longGraceTimeouts.refundTimeoutSlots, 501n);
    t.ok(
      longGraceTimeouts.deadmanTimeoutSlots >=
        longGraceTimeouts.refundTimeoutSlots * 2n,
    );
    t.end();
  },
);

await t.test("parses positive Flex display amounts", (t) => {
  t.equal(parsePositiveDisplayAmount("--amount", "1", 6), "1000000");
  t.equal(parsePositiveDisplayAmount("--amount", "0.25", 6), "250000");
  t.equal(parsePositiveDisplayAmount("--amount", ".000001", 6), "1");
  t.throws(
    () => parsePositiveDisplayAmount("--amount", "0", 6),
    /--amount must be greater than zero/,
  );
  t.throws(
    () => parsePositiveDisplayAmount("--amount", "abc", 6),
    /--amount must be a decimal amount/,
  );
  t.throws(
    () => parsePositiveDisplayAmount("--amount", "0.0000001", 6),
    /--amount has more decimal places than this Flex session asset supports/,
  );
  t.end();
});

await t.test("persists and matches Flex session runtime records", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "corbits-flex-"));
  const storePath = path.join(tempDir, "flex-sessions.json");

  const record = await createFlexSessionRecord({
    ownerAddress: resolvedConfig.activeWallet.address,
    network: flexRequirement.network,
    mint: flexRequirement.asset,
    facilitator: flexRequirement.extra.facilitator,
    escrow: "Escrow1111111111111111111111111111111111",
    sessionKeyAddress: "SessionKey11111111111111111111111111111",
    sessionKeyAccount: "SessionPda11111111111111111111111111111",
    depositedAmount: "1000",
    storePath,
  });
  const store = await readFlexSessionStore(storePath);
  t.equal(store.sessions.length, 1);
  t.equal(store.sessions[0]?.id, record.id);

  const matching = findMatchingFlexSessions({
    sessions: store.sessions,
    ownerAddress: resolvedConfig.activeWallet.address,
    network: flexRequirement.network,
    mint: flexRequirement.asset,
    facilitator: flexRequirement.extra.facilitator,
  });
  t.same(
    matching.map((session) => session.id),
    [record.id],
  );

  await writeFlexSessionStore({ version: 1, sessions: [] }, storePath);
  t.same((await readFlexSessionStore(storePath)).sessions, []);
});

await t.test(
  "top-up options are limited to active wallet and Solana network",
  (t) => {
    const baseSession: FlexSessionRecord = {
      id: "eligible",
      status: "open",
      owner_address: resolvedConfig.activeWallet.address,
      network: flexRequirement.network,
      mint: flexRequirement.asset,
      facilitator: flexRequirement.extra.facilitator,
      escrow: "Escrow1111111111111111111111111111111111",
      session_key_address: "SessionKey11111111111111111111111111111",
      session_key_account: "SessionPda11111111111111111111111111111",
      session_key_path: "/tmp/flex-session-key.json",
      deposited_amount: "1000",
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const view = (session: FlexSessionRecord): FlexSessionRuntimeView => ({
      session,
      availableAmount: "1000",
      vaultBalanceAmount: "1000",
      pendingAmount: "0",
    });
    const filtered = filterEligibleTopupSessionViews(
      [
        view(baseSession),
        view({ ...baseSession, id: "closed", status: "closed" }),
        view({
          ...baseSession,
          id: "wrong-owner",
          owner_address: "OtherOwner111111111111111111111111111111",
        }),
        view({
          ...baseSession,
          id: "wrong-network",
          network: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
        }),
      ],
      resolvedConfig,
    );

    t.same(
      filtered.map((entry) => entry.session.id),
      ["eligible"],
    );
    t.end();
  },
);

await t.test("preserves structured Flex status rows", (t) => {
  const session: FlexSessionRecord = {
    id: "eligible",
    status: "open",
    owner_address: resolvedConfig.activeWallet.address,
    network: flexRequirement.network,
    mint: flexRequirement.asset,
    facilitator: flexRequirement.extra.facilitator,
    escrow: "Escrow1111111111111111111111111111111111",
    session_key_address: "SessionKey11111111111111111111111111111",
    session_key_account: "SessionPda11111111111111111111111111111",
    session_key_path: "/tmp/flex-session-key.json",
    deposited_amount: "1000",
    created_at_ms: 1,
    updated_at_ms: 1,
  };

  t.same(statusRows([{ session, availableAmount: "2500" }]), [
    {
      id: "eligible",
      status: "open",
      owner: resolvedConfig.activeWallet.address,
      network: flexRequirement.network,
      mint: flexRequirement.asset,
      facilitator: flexRequirement.extra.facilitator,
      escrow: "Escrow1111111111111111111111111111111111",
      sessionKey: "SessionKey11111111111111111111111111111",
      totalDepositedAmount: "1000",
      onChainVaultBalance: "",
      onChainAvailableAmount: "2500",
      onChainPendingAmount: "",
      issue: "",
    },
  ]);

  t.same(
    statusRows([
      {
        session,
        issue: "session key is not active",
      },
    ])[0],
    {
      id: "eligible",
      status: "open",
      owner: resolvedConfig.activeWallet.address,
      network: flexRequirement.network,
      mint: flexRequirement.asset,
      facilitator: flexRequirement.extra.facilitator,
      escrow: "Escrow1111111111111111111111111111111111",
      sessionKey: "SessionKey11111111111111111111111111111",
      totalDepositedAmount: "1000",
      onChainVaultBalance: "",
      onChainAvailableAmount: "",
      onChainPendingAmount: "",
      issue: "session key is not active",
    },
  );
  t.end();
});

await t.test("formats Flex status rows for display", (t) => {
  const session: FlexSessionRecord = {
    id: "eligible",
    status: "open",
    owner_address: resolvedConfig.activeWallet.address,
    network: flexRequirement.network,
    mint: flexRequirement.asset,
    facilitator: flexRequirement.extra.facilitator,
    escrow: "Escrow1111111111111111111111111111111111",
    session_key_address: "SessionKey11111111111111111111111111111",
    session_key_account: "SessionPda11111111111111111111111111111",
    session_key_path: "/tmp/flex-session-key.json",
    deposited_amount: "1000",
    created_at_ms: 1,
    updated_at_ms: 1,
  };

  t.same(statusDisplayRows([{ session, availableAmount: "2500" }]), [
    {
      id: "eligible",
      status: "open",
      network: "solana-devnet",
      asset: "USDC",
      assetAddress: flexRequirement.asset,
      deposited: "0.001000",
      available: "0.002500",
      owner: resolvedConfig.activeWallet.address,
      escrow: "Escrow1111111111111111111111111111111111",
      sessionKey: "SessionKey11111111111111111111111111111",
    },
  ]);

  t.same(
    statusDisplayRows([
      {
        session,
        issue: "session key is not active",
      },
    ])[0],
    {
      id: "eligible",
      status: "open",
      network: "solana-devnet",
      asset: "USDC",
      assetAddress: flexRequirement.asset,
      deposited: "0.001000",
      issue: "session key is not active",
      owner: resolvedConfig.activeWallet.address,
      escrow: "Escrow1111111111111111111111111111111111",
      sessionKey: "SessionKey11111111111111111111111111111",
    },
  );
  t.end();
});

await t.test(
  "prints Flex top-up result with total deposited amount",
  async (t) => {
    const session: FlexSessionRecord = {
      id: "eligible",
      status: "open",
      owner_address: resolvedConfig.activeWallet.address,
      network: flexRequirement.network,
      mint: flexRequirement.asset,
      facilitator: flexRequirement.extra.facilitator,
      escrow: "Escrow1111111111111111111111111111111111",
      session_key_address: "SessionKey11111111111111111111111111111",
      session_key_account: "SessionPda11111111111111111111111111111",
      session_key_path: "/tmp/flex-session-key.json",
      deposited_amount: "1500000",
      created_at_ms: 1,
      updated_at_ms: 1,
    };

    const output = await captureStdout(() =>
      printTopupResult("json", {
        session,
        amount: "500000",
        signature: "tx-sig",
      }),
    );
    t.same(JSON.parse(output), {
      sessionId: "eligible",
      amount: "0.500000",
      asset: "USDC",
      network: "solana-devnet",
      escrow: "Escrow1111111111111111111111111111111111",
      totalDepositedAmount: "1.500000",
      txSignature: "tx-sig",
    });
  },
);

await t.test("uses --yes for non-interactive Flex authorization", async (t) => {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  t.teardown(() => {
    process.exitCode = priorExitCode;
  });

  const call = createCallCommand({
    loadRequiredConfig: async () => ({
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
            address: resolvedConfig.activeWallet.address,
            path: "~/.config/solana/id.json",
          },
        },
      },
      resolved: resolvedConfig,
    }),
    buildPaymentRetryHeader: async () => {
      throw new Error("should not use exact payment builder");
    },
    buildFlexPaymentRetryHeader: async (args) => {
      throw new Error(`allowCreateOrTopup=${String(args.allowCreateOrTopup)}`);
    },
    runWrappedClient: async () => ({
      kind: "payment-required",
      tool: "curl",
      url: "https://example.com/flex",
      requestInit: { method: "GET" },
      response: createPaymentRequiredResponse(),
    }),
    canPromptForConfirmation: () => false,
  });

  const stderr = await captureStderr(() =>
    call.handler({
      inspect: false,
      paymentInfo: false,
      saveResponse: false,
      yes: true,
      flexSession: undefined,
      asset: undefined,
      format: undefined,
      tool: "curl",
      args: ["https://example.com/flex"],
    }),
  );

  t.match(stderr, /allowCreateOrTopup=true/);
});

await t.test(
  "formats Flex payment info with the CLI network display",
  async (t) => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    t.teardown(() => {
      process.exitCode = priorExitCode;
    });

    const call = createCallCommand({
      loadRequiredConfig: async () => ({
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
              address: resolvedConfig.activeWallet.address,
              path: "~/.config/solana/id.json",
            },
          },
        },
        resolved: resolvedConfig,
      }),
      buildPaymentRetryHeader: async () => {
        throw new Error("should not use exact payment builder");
      },
      buildFlexPaymentRetryHeader: async () => ({
        detectedVersion: 2,
        header: { name: V2_PAYMENT_HEADER, value: "flex-paid" },
        paymentInfo: {
          amount: flexRequirement.amount,
          asset: flexRequirement.asset,
          assetSymbol: "USDC",
          network: flexRequirement.network,
          decimals: 6,
          sessionId: "flex-session-1",
          escrow: "Escrow1111111111111111111111111111111111",
        },
      }),
      runWrappedClient: async (args) =>
        args.extraHeader == null
          ? {
              kind: "payment-required",
              tool: "curl",
              url: "https://example.com/flex",
              requestInit: { method: "GET" },
              response: createPaymentRequiredResponse(),
            }
          : {
              kind: "completed",
              exitCode: 0,
              status: 200,
              stdout: Buffer.from('{"ok":true}'),
              stderr: new Uint8Array(),
              headers: new Headers(),
            },
      appendHistoryRecord: async () => void 0,
      canPromptForConfirmation: () => false,
    });

    const output = await captureCombinedOutput(() =>
      call.handler({
        inspect: false,
        paymentInfo: true,
        saveResponse: false,
        yes: true,
        flexSession: undefined,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com/flex"],
      }),
    );

    t.match(output, /Payment: 0\.001000 USDC on solana-devnet/);
    t.match(output, /flex session flex-session-1/);
    t.notMatch(output, /solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/);
  },
);

await t.test(
  "routes v1 Flex challenges through Flex authorization",
  async (t) => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    t.teardown(() => {
      process.exitCode = priorExitCode;
    });

    const call = createCallCommand({
      loadRequiredConfig: async () => ({
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
              address: resolvedConfig.activeWallet.address,
              path: "~/.config/solana/id.json",
            },
          },
        },
        resolved: resolvedConfig,
      }),
      buildPaymentRetryHeader: async () => {
        throw new Error("should not use exact payment builder");
      },
      buildFlexPaymentRetryHeader: async () => {
        throw new Error("used v1 flex builder");
      },
      runWrappedClient: async () => ({
        kind: "payment-required",
        tool: "curl",
        url: "https://example.com/flex",
        requestInit: { method: "POST" },
        response: createV1PaymentRequiredResponse(),
      }),
      canPromptForConfirmation: () => false,
    });

    const stderr = await captureStderr(() =>
      call.handler({
        inspect: false,
        paymentInfo: false,
        saveResponse: false,
        yes: true,
        flexSession: undefined,
        asset: undefined,
        format: undefined,
        tool: "curl",
        args: ["https://example.com/flex"],
      }),
    );

    t.match(stderr, /used v1 flex builder/);
  },
);
