#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import t from "tap";
import { V2_PAYMENT_REQUIRED_HEADER } from "@faremeter/types/x402v2";

import { createCallCommand } from "../src/commands/call.js";
import { filterEligibleTopupSessionViews } from "../src/commands/flex.js";
import {
  createFlexSessionRecord,
  findMatchingFlexSessions,
  parsePositiveBaseUnitAmount,
  readFlexSessionStore,
  selectFlexRequirement,
  type FlexSessionRecord,
  type FlexSessionRuntimeView,
  writeFlexSessionStore,
} from "../src/payment/flex.js";
import { getFlexEscrowTimeoutSlots } from "../src/payment/flex-solana.js";
import { captureStderr } from "./test-helpers.js";

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

await t.test("normalizes positive base-unit amounts and rejects zero", (t) => {
  t.equal(parsePositiveBaseUnitAmount("--amount", "000123"), "123");
  t.throws(
    () => parsePositiveBaseUnitAmount("--amount", "0"),
    /--amount must be greater than zero/,
  );
  t.throws(
    () => parsePositiveBaseUnitAmount("--amount", "1.5"),
    /--amount must be an integer base-unit amount/,
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
      healthy: true,
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
