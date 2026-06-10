#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import t from "tap";
import { X_PAYMENT_HEADER } from "@faremeter/types/x402";
import {
  V2_PAYMENT_HEADER,
  V2_PAYMENT_REQUIRED_HEADER,
} from "@faremeter/types/x402v2";
import {
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import {
  createCallCommand,
  isSelectedFlexInspectionRequirement,
} from "../src/commands/call.js";
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
  ensureFlexSession,
  getFlexEscrowTimeoutSlots,
  isMissingTokenAccountBalanceError,
  type FlexSolanaDeps,
} from "../src/payment/flex-solana.js";
import {
  captureCombinedOutput,
  captureStderr,
  captureStdout,
} from "./test-helpers.js";

type CallCommandDeps = Parameters<typeof createCallCommand>[0];

function createTestCallCommand(
  deps: Omit<CallCommandDeps, "appendHistoryRecord"> &
    Partial<Pick<CallCommandDeps, "appendHistoryRecord">>,
) {
  return createCallCommand({
    appendHistoryRecord: async () => void 0,
    ...deps,
  });
}

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

const TEST_OWNER_SECRET_KEY = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 121, 181, 86, 46, 143, 230, 84, 249,
  64, 120, 177, 18, 232, 169, 139, 167, 144, 31, 133, 58, 230, 149, 190, 215,
  224, 227, 145, 11, 173, 4, 150, 100,
] as const;

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

async function randomAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

function testInstruction(
  label: string,
  accounts: { address: Address }[] = [],
): Instruction {
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts,
    data: new Uint8Array(),
    label,
  } as unknown as Instruction;
}

function instructionLabel(instruction: Instruction): string {
  return (
    (
      instruction as unknown as {
        label?: string;
      }
    ).label ?? "unknown"
  );
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

await t.test(
  "matches inspect enrichment only to the selected Flex row",
  (t) => {
    const selection = selectFlexRequirement({
      accepts: [flexRequirement],
      config: resolvedConfig,
    });
    t.equal(selection.kind, "selected");
    if (selection.kind !== "selected") {
      t.end();
      return;
    }

    const selectedRow = {
      scheme: "flex",
      network: "solana-devnet",
      asset: "USDC",
      assetAddress: flexRequirement.asset,
      amount: "0.001000",
      payTo: flexRequirement.payTo,
      maxTimeoutSeconds: flexRequirement.maxTimeoutSeconds,
      extra: flexRequirement.extra,
    };

    t.equal(
      isSelectedFlexInspectionRequirement(selectedRow, selection.selected),
      true,
    );
    t.equal(
      isSelectedFlexInspectionRequirement(
        {
          ...selectedRow,
          asset: "USDT",
          assetAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        },
        selection.selected,
      ),
      false,
    );
    t.equal(
      isSelectedFlexInspectionRequirement(
        {
          ...selectedRow,
          extra: {
            ...flexRequirement.extra,
            facilitator: "OtherFacilitator111111111111111111111111",
          },
        },
        selection.selected,
      ),
      false,
    );
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

await t.test("classifies only missing token account balance errors", (t) => {
  t.equal(
    isMissingTokenAccountBalanceError(
      new Error("Invalid param: could not find account"),
    ),
    true,
  );
  t.equal(
    isMissingTokenAccountBalanceError(new Error("token account not found")),
    true,
  );
  t.equal(
    isMissingTokenAccountBalanceError(new Error("429 Too Many Requests")),
    false,
  );
  t.equal(
    isMissingTokenAccountBalanceError(new Error("failed to fetch")),
    false,
  );
  t.end();
});

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

await t.test(
  "stores a new Flex session before sending the initial deposit",
  async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "corbits-flex-"));
    const storePath = path.join(tempDir, "flex-sessions.json");
    const ownerSecretKey = Uint8Array.from(TEST_OWNER_SECRET_KEY);
    const ownerSigner = await createKeyPairSignerFromBytes(ownerSecretKey);
    const facilitatorAddress = await randomAddress();
    const sessionKeyAddress = await randomAddress();
    const sourceTokenAccount = await randomAddress();
    const decoyEscrowAccountMeta = await randomAddress();
    const decoySessionKeyAccountMeta = await randomAddress();
    let derivedEscrowAddress: Address | undefined;
    let derivedSessionKeyAccount: Address | undefined;
    const sends: string[] = [];
    const deps: Partial<FlexSolanaDeps> = {
      readTextFile: async () => JSON.stringify([...ownerSecretKey]),
      createRpc: (() =>
        ({
          getTokenAccountsByOwner: () => ({
            send: async () => ({
              value: [{ pubkey: sourceTokenAccount }],
            }),
          }),
        }) as unknown as ReturnType<
          FlexSolanaDeps["createRpc"]
        >) as FlexSolanaDeps["createRpc"],
      getCreateEscrowInstructionAsync: (async (
        input: Parameters<FlexSolanaDeps["getCreateEscrowInstructionAsync"]>[0],
      ) => {
        t.equal(input.index, 1234567890n);
        t.ok(input.escrow, "create escrow instruction receives derived escrow");
        derivedEscrowAddress = input.escrow;
        return testInstruction("create", [
          { address: await randomAddress() },
          { address: decoyEscrowAccountMeta },
        ]);
      }) as unknown as FlexSolanaDeps["getCreateEscrowInstructionAsync"],
      getDepositInstructionAsync: (async () =>
        testInstruction(
          "deposit",
        )) as unknown as FlexSolanaDeps["getDepositInstructionAsync"],
      getRegisterSessionKeyInstructionAsync: (async (
        input: Parameters<
          FlexSolanaDeps["getRegisterSessionKeyInstructionAsync"]
        >[0],
      ) => {
        t.equal(input.escrow, derivedEscrowAddress);
        t.equal(input.sessionKey, sessionKeyAddress);
        t.ok(
          input.sessionKeyAccount,
          "register instruction receives derived session key account",
        );
        derivedSessionKeyAccount = input.sessionKeyAccount;
        return testInstruction("register", [
          { address: await randomAddress() },
          { address: await randomAddress() },
          { address: decoySessionKeyAccountMeta },
        ]);
      }) as unknown as FlexSolanaDeps["getRegisterSessionKeyInstructionAsync"],
      generateFlexSessionKeyPair: async () =>
        webcrypto.subtle.generateKey("Ed25519", true, [
          "sign",
          "verify",
        ]) as Promise<webcrypto.CryptoKeyPair>,
      getAddressFromPublicKey: async () => sessionKeyAddress,
      now: () => 1234567890,
      sendInstructions: async (_rpc, _feePayer, instructions) => {
        const firstInstruction = instructions[0];
        if (firstInstruction == null) {
          throw new Error("expected one instruction");
        }
        const label = instructionLabel(firstInstruction);
        if (label === "deposit") {
          const store = await readFlexSessionStore(storePath);
          t.equal(store.sessions.length, 1);
          t.equal(store.sessions[0]?.deposited_amount, "0");
        }
        sends.push(label);
        return "tx-signature" as Signature;
      },
    };

    const result = await ensureFlexSession(
      {
        config: {
          ...resolvedConfig,
          activeWallet: {
            ...resolvedConfig.activeWallet,
            address: ownerSigner.address,
            expandedPath: "/tmp/flex-owner.json",
          },
        },
        requirement: {
          requirement: flexRequirement,
          scheme: "flex",
          network: flexRequirement.network,
          amount: flexRequirement.amount,
          asset: flexRequirement.asset,
          symbol: "USDC",
          decimals: 6,
          facilitator: facilitatorAddress,
          minGracePeriodSlots: 12n,
        },
        amount: flexRequirement.amount,
        allowCreateOrTopup: true,
        storePath,
      },
      deps,
    );

    t.same(sends, ["create", "register", "deposit"]);
    t.equal(result.session.deposited_amount, flexRequirement.amount);
    t.equal(result.session.escrow, derivedEscrowAddress);
    t.equal(result.session.session_key_account, derivedSessionKeyAccount);
    t.not(result.session.escrow, decoyEscrowAccountMeta);
    t.not(result.session.session_key_account, decoySessionKeyAccountMeta);
    const store = await readFlexSessionStore(storePath);
    t.equal(store.sessions[0]?.deposited_amount, flexRequirement.amount);
  },
);

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

  const call = createTestCallCommand({
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

    const call = createTestCallCommand({
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

    const call = createTestCallCommand({
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
