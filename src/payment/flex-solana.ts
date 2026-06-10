import fs from "node:fs/promises";

import { translateNetworkToLegacy } from "@faremeter/info";
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchSessionKey,
  findPendingSettlementsByEscrow,
  findVaultPda,
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
} from "@faremeter/flex-solana";
import { createPaymentHandler as createFlexPaymentHandler } from "@faremeter/payment-solana/flex/client";
import type { PaymentHandler } from "@faremeter/types/client";
import {
  X_PAYMENT_HEADER,
  type x402PaymentPayload as x402PaymentPayloadV1,
} from "@faremeter/types/x402";
import {
  V2_PAYMENT_HEADER,
  type x402PaymentPayload,
  type x402ResourceInfo,
  type x402PaymentRequirements,
} from "@faremeter/types/x402v2";

import { ConfigError, type ResolvedConfig } from "../config/index.js";
import type { RetryHeader } from "../process/wrapped-client.js";
import {
  applyFlexDeposit,
  compareBaseUnitAmounts,
  createFlexSessionRecord,
  findMatchingFlexSessions,
  formatFlexRequirementMismatch,
  generateFlexSessionKeyPair,
  getConfiguredSolanaNetwork,
  readFlexSessionKeyPair,
  readFlexSessionStore,
  selectFlexRequirement,
  subtractBaseUnits,
  toSolanaAddress,
  upsertFlexSessionRecord,
  writeFlexSessionKeyMaterial,
  type FlexRequirementDetails,
  type FlexSessionReadiness,
  type FlexSessionRecord,
  type FlexSessionRuntimeView,
} from "./flex.js";
import { formatDisplayTokenAmount } from "../output/format.js";
import {
  getKnownPaymentAssetDecimals,
  resolvePaymentAssetSymbol,
} from "./requirements.js";

const MIN_REFUND_TIMEOUT_SLOTS = 150n;
const DEFAULT_REFUND_TIMEOUT_SLOTS = 300n;
const MIN_DEADMAN_TIMEOUT_SLOTS = 1_000n;
const DEFAULT_DEADMAN_TIMEOUT_SLOTS = 100_000n;
const DEFAULT_MAX_SESSION_KEYS = 10;

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
type FlexReadRpc = Parameters<typeof fetchEscrowAccount>[0];
type FlexPaymentHandlerRpc = Parameters<
  typeof createFlexPaymentHandler
>[0]["rpc"];

function asFlexReadRpc(rpc: SolanaRpc): FlexReadRpc {
  return rpc as unknown as FlexReadRpc;
}

function asFlexPaymentHandlerRpc(rpc: SolanaRpc): FlexPaymentHandlerRpc {
  return rpc as unknown as FlexPaymentHandlerRpc;
}

export type FlexPaymentMetadata = {
  amount: string;
  asset: string;
  assetSymbol?: string;
  network: string;
  decimals?: number;
  sessionId: string;
  escrow: string;
};

export type FlexPaymentRetryHeaderResult = {
  detectedVersion: 1 | 2;
  header: RetryHeader;
  paymentInfo: FlexPaymentMetadata;
};

export type EnsureFlexSessionArgs = {
  config: ResolvedConfig;
  requirement: FlexRequirementDetails;
  amount: string;
  sessionId?: string;
  allowCreateOrTopup: boolean;
  confirm?: (args: FlexConfirmArgs) => Promise<boolean>;
  note?: (message: string) => void;
  storePath?: string;
};

export type FlexConfirmArgs =
  | {
      kind: "create";
      amount: string;
      requirement: FlexRequirementDetails;
    }
  | {
      kind: "topup";
      amount: string;
      session: FlexSessionRecord;
      requirement: FlexRequirementDetails;
    };

export type FlexSolanaDeps = {
  readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  createRpc: (rpcURL: string) => SolanaRpc;
  createFlexPaymentHandler: typeof createFlexPaymentHandler;
  getCreateEscrowInstructionAsync: typeof getCreateEscrowInstructionAsync;
  getDepositInstructionAsync: typeof getDepositInstructionAsync;
  getRegisterSessionKeyInstructionAsync: typeof getRegisterSessionKeyInstructionAsync;
  generateFlexSessionKeyPair: typeof generateFlexSessionKeyPair;
  getAddressFromPublicKey: typeof getAddressFromPublicKey;
  sendInstructions: typeof sendInstructions;
  now: () => number;
};

export type EnsureFlexSessionResult = {
  session: FlexSessionRecord;
  availableAmount: string;
  created: boolean;
  toppedUpAmount?: string;
};

export type BuildFlexPaymentRetryHeaderArgs = {
  config: ResolvedConfig;
  response: Response;
  url: string;
  requestInit: RequestInit;
  sessionId?: string;
  allowCreateOrTopup: boolean;
  confirm?: EnsureFlexSessionArgs["confirm"];
  note?: EnsureFlexSessionArgs["note"];
  storePath?: string;
};

export function buildFlexPaymentHeader(args: {
  detectedVersion: 1 | 2;
  requirements: x402PaymentRequirements;
  payload: object;
  resource?: x402ResourceInfo;
}): RetryHeader {
  if (args.detectedVersion === 2) {
    return {
      name: V2_PAYMENT_HEADER,
      value: Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: args.requirements,
          payload: args.payload,
          ...(args.resource == null ? {} : { resource: args.resource }),
        } satisfies x402PaymentPayload),
        "utf8",
      ).toString("base64"),
    };
  }

  return {
    name: X_PAYMENT_HEADER,
    value: Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: args.requirements.scheme,
        network: translateNetworkToLegacy(args.requirements.network),
        asset: args.requirements.asset,
        payload: args.payload,
      } satisfies x402PaymentPayloadV1),
      "utf8",
    ).toString("base64"),
  };
}

function formatFlexRequirementAmount(
  amount: string,
  requirement: FlexRequirementDetails,
): string {
  const asset = requirement.symbol ?? requirement.asset;
  return `${formatDisplayTokenAmount({
    amount,
    asset,
    ...(requirement.decimals == null ? {} : { decimals: requirement.decimals }),
  })} ${asset}`;
}

function formatFlexSessionAmount(
  amount: string,
  session: FlexSessionRecord,
): string {
  const asset = resolvePaymentAssetSymbol(session.network, session.mint);
  const assetDisplay = asset ?? session.mint;
  return `${formatDisplayTokenAmount({
    amount,
    asset: assetDisplay,
    decimals: getKnownPaymentAssetDecimals(session.network, session.mint),
  })} ${assetDisplay}`;
}

function parseSolanaSecretKey(value: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(
      "configured Solana keypair file does not contain valid JSON",
    );
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => !Number.isInteger(item))
  ) {
    throw new ConfigError(
      "configured Solana keypair file must contain an array of secret key bytes",
    );
  }

  return Uint8Array.from(parsed);
}

async function loadOwnerSigner(
  config: ResolvedConfig,
  deps: Pick<FlexSolanaDeps, "readTextFile">,
): Promise<KeyPairSigner> {
  if (
    config.activeWallet.kind !== "keypair" ||
    config.activeWallet.family !== "solana"
  ) {
    throw new ConfigError(
      "Flex payments currently require an active Solana keypair wallet",
    );
  }

  const secret = await deps.readTextFile(
    config.activeWallet.expandedPath,
    "utf8",
  );
  return createKeyPairSignerFromBytes(parseSolanaSecretKey(secret));
}

async function confirmSignature(rpc: SolanaRpc, sig: Signature): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    const status = statuses[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Transaction confirmation timeout");
}

async function sendInstructions(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
  const signature = await rpc
    .sendTransaction(wireTransaction, { encoding: "base64" })
    .send();
  await confirmSignature(rpc, signature);
  return signature;
}

async function findOwnerTokenAccount(args: {
  rpc: SolanaRpc;
  owner: Address;
  mint: Address;
}): Promise<Address> {
  const { value: tokenAccounts } = await args.rpc
    .getTokenAccountsByOwner(
      args.owner,
      { mint: args.mint },
      { encoding: "base64" },
    )
    .send();
  const firstAccount = tokenAccounts[0];
  if (firstAccount == null) {
    throw new Error(
      `No token account found for mint ${args.mint}. Fund the configured wallet before creating or topping up a Flex session.`,
    );
  }
  return firstAccount.pubkey;
}

async function getTokenAccountBalance(
  rpc: SolanaRpc,
  tokenAccount: Address,
): Promise<string> {
  try {
    const { value } = await rpc.getTokenAccountBalance(tokenAccount).send();
    return value.amount;
  } catch (err) {
    if (isMissingTokenAccountBalanceError(err)) {
      return "0";
    }
    throw err;
  }
}

export function isMissingTokenAccountBalanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not find account|token account not found|account does not exist/i.test(
    message,
  );
}

async function getSessionReadiness(
  rpc: SolanaRpc,
  session: FlexSessionRecord,
  requiredAmount: string,
): Promise<FlexSessionReadiness> {
  const escrowAddress = toSolanaAddress(session.escrow);
  const escrow = await fetchEscrowAccount(asFlexReadRpc(rpc), escrowAddress);
  if (escrow == null) {
    return { kind: "unusable", session, issue: "escrow not found on-chain" };
  }

  const sessionKey = await fetchSessionKey(
    asFlexReadRpc(rpc),
    toSolanaAddress(session.session_key_account),
  );
  if (sessionKey == null) {
    return {
      kind: "unusable",
      session,
      issue: "session key account not found on-chain",
    };
  }
  if (!sessionKey.active) {
    return { kind: "unusable", session, issue: "session key is not active" };
  }

  const pending = await findPendingSettlementsByEscrow(
    asFlexReadRpc(rpc),
    escrowAddress,
  );
  const pendingAmount = pending
    .reduce((sum, entry) => sum + entry.account.amount, 0n)
    .toString();
  const [vaultAddress] = await findVaultPda({
    escrow: escrowAddress,
    mint: toSolanaAddress(session.mint),
  });
  const vaultBalance = await getTokenAccountBalance(rpc, vaultAddress);
  const availableAmount = subtractBaseUnits(vaultBalance, pendingAmount);

  if (compareBaseUnitAmounts(availableAmount, requiredAmount) >= 0) {
    return {
      kind: "ready",
      session,
      availableAmount,
      vaultBalanceAmount: vaultBalance,
      pendingAmount,
    };
  }

  return {
    kind: "underfunded",
    session,
    availableAmount,
    vaultBalanceAmount: vaultBalance,
    pendingAmount,
    shortfallAmount: subtractBaseUnits(requiredAmount, availableAmount),
  };
}

export async function getFlexSessionViews(args: {
  config: ResolvedConfig;
  requirement?: FlexRequirementDetails;
  storePath?: string;
  deps?: Partial<FlexSolanaDeps>;
}): Promise<FlexSessionRuntimeView[]> {
  const deps = { ...defaultFlexSolanaDeps, ...args.deps };
  const store = await readFlexSessionStore(args.storePath);
  const sessions =
    args.requirement == null
      ? store.sessions
      : findMatchingFlexSessions({
          sessions: store.sessions,
          ownerAddress: args.config.activeWallet.address,
          network: args.requirement.network,
          mint: args.requirement.asset,
          facilitator: args.requirement.facilitator,
        });

  const rpc = deps.createRpc(args.config.payment.rpcURL);
  const views: FlexSessionRuntimeView[] = [];
  for (const session of sessions) {
    try {
      const readiness = await getSessionReadiness(rpc, session, "0");
      if (readiness.kind === "unusable") {
        views.push({ session, issue: readiness.issue });
      } else {
        views.push({
          session,
          availableAmount: readiness.availableAmount,
          vaultBalanceAmount: readiness.vaultBalanceAmount,
          pendingAmount: readiness.pendingAmount,
        });
      }
    } catch (err) {
      views.push({
        session,
        issue: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return views;
}

async function chooseExistingSession(args: {
  config: ResolvedConfig;
  requirement: FlexRequirementDetails;
  requiredAmount: string;
  sessionId?: string;
  confirm?: EnsureFlexSessionArgs["confirm"];
  rpc: SolanaRpc;
  storePath?: string;
}): Promise<FlexSessionReadiness | null> {
  const store = await readFlexSessionStore(args.storePath);
  const matching = findMatchingFlexSessions({
    sessions: store.sessions,
    ownerAddress: args.config.activeWallet.address,
    network: args.requirement.network,
    mint: args.requirement.asset,
    facilitator: args.requirement.facilitator,
  });
  const candidates =
    args.sessionId == null
      ? matching
      : matching.filter((session) => session.id === args.sessionId);

  if (args.sessionId != null && candidates.length === 0) {
    throw new Error(
      `Flex session ${args.sessionId} was not found or does not match this challenge`,
    );
  }

  const readinessResults = await Promise.all(
    candidates.map((session) =>
      getSessionReadiness(args.rpc, session, args.requiredAmount),
    ),
  );
  const usable = readinessResults.filter(
    (readiness) => readiness.kind !== "unusable",
  );

  if (args.sessionId != null) {
    const selected = usable[0];
    if (selected == null) {
      const unusable = readinessResults[0];
      throw new Error(
        unusable?.kind === "unusable"
          ? `Flex session ${args.sessionId} is not usable: ${unusable.issue}`
          : `Flex session ${args.sessionId} is not usable`,
      );
    }
    return selected;
  }

  const fullyFunded = usable.filter((readiness) => readiness.kind === "ready");
  if (fullyFunded.length === 1) {
    return fullyFunded[0] ?? null;
  }
  if (fullyFunded.length > 1) {
    throw new Error(
      "Multiple matching Flex sessions are available; rerun with --flex-session <id>",
    );
  }

  if (usable.length === 1) {
    return usable[0] ?? null;
  }
  if (usable.length > 1) {
    throw new Error(
      "Multiple underfunded Flex sessions match this challenge; rerun with --flex-session <id>",
    );
  }
  return null;
}

async function topUpSession(args: {
  config: ResolvedConfig;
  owner: KeyPairSigner;
  rpc: SolanaRpc;
  session: FlexSessionRecord;
  mint: string;
  amount: string;
  storePath?: string;
}): Promise<{ session: FlexSessionRecord; signature: string }> {
  const mint = toSolanaAddress(args.mint);
  const sourceTokenAccount = await findOwnerTokenAccount({
    rpc: args.rpc,
    owner: args.owner.address,
    mint,
  });
  const depositIx = await getDepositInstructionAsync({
    depositor: args.owner,
    escrow: toSolanaAddress(args.session.escrow),
    mint,
    source: sourceTokenAccount,
    amount: BigInt(args.amount),
  });
  const signature = await sendInstructions(args.rpc, args.owner, [depositIx]);
  const updated = applyFlexDeposit(args.session, args.amount);
  await upsertFlexSessionRecord(updated, args.storePath);
  return { session: updated, signature };
}

async function createSession(args: {
  config: ResolvedConfig;
  owner: KeyPairSigner;
  rpc: SolanaRpc;
  requirement: FlexRequirementDetails;
  amount: string;
  deps: Pick<
    FlexSolanaDeps,
    | "generateFlexSessionKeyPair"
    | "getAddressFromPublicKey"
    | "getCreateEscrowInstructionAsync"
    | "getDepositInstructionAsync"
    | "getRegisterSessionKeyInstructionAsync"
    | "now"
    | "sendInstructions"
  >;
  storePath?: string;
}): Promise<FlexSessionRecord> {
  const mint = toSolanaAddress(args.requirement.asset);
  const sourceTokenAccount = await findOwnerTokenAccount({
    rpc: args.rpc,
    owner: args.owner.address,
    mint,
  });
  const { refundTimeoutSlots, deadmanTimeoutSlots } = getFlexEscrowTimeoutSlots(
    args.requirement.minGracePeriodSlots,
  );
  const createIx = await args.deps.getCreateEscrowInstructionAsync({
    owner: args.owner,
    index: BigInt(args.deps.now()),
    facilitator: toSolanaAddress(args.requirement.facilitator),
    refundTimeoutSlots,
    deadmanTimeoutSlots,
    maxSessionKeys: DEFAULT_MAX_SESSION_KEYS,
  });
  const escrowMeta = createIx.accounts[1];
  if (escrowMeta == null) {
    throw new Error("escrow account meta missing");
  }
  const escrowAddress = escrowMeta.address;
  await args.deps.sendInstructions(args.rpc, args.owner, [createIx]);

  const sessionKeyPair = await args.deps.generateFlexSessionKeyPair();
  const sessionKeyAddress = await args.deps.getAddressFromPublicKey(
    sessionKeyPair.publicKey,
  );
  const registerIx = await args.deps.getRegisterSessionKeyInstructionAsync({
    owner: args.owner,
    escrow: escrowAddress,
    sessionKey: sessionKeyAddress,
    expiresAtSlot: null,
    revocationGracePeriodSlots: args.requirement.minGracePeriodSlots,
  });
  const sessionKeyMeta = registerIx.accounts[2];
  if (sessionKeyMeta == null) {
    throw new Error("session key account meta missing");
  }

  const record = await createFlexSessionRecord({
    ownerAddress: args.config.activeWallet.address,
    network: args.requirement.network,
    mint: args.requirement.asset,
    facilitator: args.requirement.facilitator,
    escrow: escrowAddress,
    sessionKeyAddress,
    sessionKeyAccount: sessionKeyMeta.address,
    depositedAmount: "0",
    ...(args.storePath == null ? {} : { storePath: args.storePath }),
  });
  await writeFlexSessionKeyMaterial(record, sessionKeyPair);
  await args.deps.sendInstructions(args.rpc, args.owner, [registerIx]);

  const depositIx = await args.deps.getDepositInstructionAsync({
    depositor: args.owner,
    escrow: escrowAddress,
    mint,
    source: sourceTokenAccount,
    amount: BigInt(args.amount),
  });
  await args.deps.sendInstructions(args.rpc, args.owner, [depositIx]);

  const fundedRecord = applyFlexDeposit(record, args.amount);
  await upsertFlexSessionRecord(fundedRecord, args.storePath);
  return fundedRecord;
}

export function getFlexEscrowTimeoutSlots(minGracePeriodSlots: bigint): {
  refundTimeoutSlots: bigint;
  deadmanTimeoutSlots: bigint;
} {
  const refundTimeoutSlots = maxBigInt(
    DEFAULT_REFUND_TIMEOUT_SLOTS,
    MIN_REFUND_TIMEOUT_SLOTS,
    minGracePeriodSlots + 1n,
  );
  const deadmanTimeoutSlots = maxBigInt(
    DEFAULT_DEADMAN_TIMEOUT_SLOTS,
    MIN_DEADMAN_TIMEOUT_SLOTS,
    refundTimeoutSlots * 2n,
  );
  return { refundTimeoutSlots, deadmanTimeoutSlots };
}

function maxBigInt(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((max, value) => (value > max ? value : max), first);
}

export async function ensureFlexSession(
  args: EnsureFlexSessionArgs,
  depsOverride: Partial<FlexSolanaDeps> = {},
): Promise<EnsureFlexSessionResult> {
  if (args.config.payment.family !== "solana") {
    throw new ConfigError(
      "Flex payments are only supported on Solana networks",
    );
  }
  const deps = { ...defaultFlexSolanaDeps, ...depsOverride };
  const rpc = deps.createRpc(args.config.payment.rpcURL);
  const owner = await loadOwnerSigner(args.config, deps);
  const targetAmount = args.amount;
  const selected = await chooseExistingSession({
    config: args.config,
    requirement: args.requirement,
    requiredAmount: targetAmount,
    ...(args.sessionId == null ? {} : { sessionId: args.sessionId }),
    ...(args.confirm == null ? {} : { confirm: args.confirm }),
    rpc,
    ...(args.storePath == null ? {} : { storePath: args.storePath }),
  });

  if (selected?.kind === "ready") {
    args.note?.(`Using Flex session ${selected.session.id}`);
    return {
      session: selected.session,
      availableAmount: selected.availableAmount,
      created: false,
    };
  }

  if (selected?.kind === "underfunded") {
    const topupAmount = selected.shortfallAmount;
    if (!args.allowCreateOrTopup) {
      throw new Error(
        `Flex session ${selected.session.id} needs a top-up of ${formatFlexRequirementAmount(topupAmount, args.requirement)}; rerun with --yes`,
      );
    }
    if (
      args.confirm != null &&
      !(await args.confirm({
        kind: "topup",
        amount: topupAmount,
        session: selected.session,
        requirement: args.requirement,
      }))
    ) {
      throw new Error("Flex top-up cancelled");
    }
    args.note?.(
      `Topping up Flex session ${selected.session.id} by ${formatFlexRequirementAmount(topupAmount, args.requirement)}`,
    );
    const topup = await topUpSession({
      config: args.config,
      owner,
      rpc,
      session: selected.session,
      mint: args.requirement.asset,
      amount: topupAmount,
      ...(args.storePath == null ? {} : { storePath: args.storePath }),
    });
    return {
      session: topup.session,
      availableAmount: targetAmount,
      created: false,
      toppedUpAmount: topupAmount,
    };
  }

  if (!args.allowCreateOrTopup) {
    throw new Error(
      "No funded Flex session matches this challenge; rerun with --yes",
    );
  }
  if (
    args.confirm != null &&
    !(await args.confirm({
      kind: "create",
      amount: targetAmount,
      requirement: args.requirement,
    }))
  ) {
    throw new Error("Flex session creation cancelled");
  }
  args.note?.(
    `Creating Flex session with deposit ${formatFlexRequirementAmount(targetAmount, args.requirement)}`,
  );
  const session = await createSession({
    config: args.config,
    owner,
    rpc,
    requirement: args.requirement,
    amount: targetAmount,
    deps,
    ...(args.storePath == null ? {} : { storePath: args.storePath }),
  });
  return {
    session,
    availableAmount: targetAmount,
    created: true,
  };
}

export async function buildFlexPaymentRetryHeader(
  args: BuildFlexPaymentRetryHeaderArgs,
  depsOverride: Partial<FlexSolanaDeps> = {},
): Promise<FlexPaymentRetryHeaderResult> {
  const { extractPaymentRequiredResponse } = await import("./signer.js");
  const paymentRequired = await extractPaymentRequiredResponse(
    args.response,
    args.url,
  );
  const selection = selectFlexRequirement({
    accepts: paymentRequired.accepts,
    config: args.config,
  });
  if (selection.kind !== "selected") {
    throw new Error(formatFlexRequirementMismatch(args.config, selection));
  }

  const ensured = await ensureFlexSession(
    {
      config: args.config,
      requirement: selection.selected,
      amount: selection.selected.amount,
      ...(args.sessionId == null ? {} : { sessionId: args.sessionId }),
      allowCreateOrTopup: args.allowCreateOrTopup,
      ...(args.confirm == null ? {} : { confirm: args.confirm }),
      ...(args.note == null ? {} : { note: args.note }),
      ...(args.storePath == null ? {} : { storePath: args.storePath }),
    },
    depsOverride,
  );
  const deps = { ...defaultFlexSolanaDeps, ...depsOverride };
  const rpc = deps.createRpc(args.config.payment.rpcURL);
  const sessionKeyPair = await readFlexSessionKeyPair(ensured.session);
  const handler: PaymentHandler = deps.createFlexPaymentHandler({
    network: selection.selected.network,
    escrow: toSolanaAddress(ensured.session.escrow),
    mint: toSolanaAddress(selection.selected.asset),
    sessionKeyPair,
    sessionKeyAddress: toSolanaAddress(ensured.session.session_key_address),
    rpc: asFlexPaymentHandlerRpc(rpc),
  });
  const execers = await handler(
    { request: new Request(args.url, args.requestInit) },
    [selection.selected.requirement],
  );
  const execer = execers[0];
  if (execer == null) {
    throw new Error("failed to build a Flex payment authorization");
  }
  const { payload } = await execer.exec();
  const header = buildFlexPaymentHeader({
    detectedVersion: paymentRequired.detectedVersion,
    requirements: execer.requirements,
    payload,
    ...(paymentRequired.resource == null
      ? {}
      : { resource: paymentRequired.resource }),
  });

  return {
    detectedVersion: paymentRequired.detectedVersion,
    header,
    paymentInfo: {
      amount: execer.requirements.amount,
      asset: execer.requirements.asset,
      ...(selection.selected.symbol == null
        ? {}
        : { assetSymbol: selection.selected.symbol }),
      network: execer.requirements.network,
      ...(selection.selected.decimals == null
        ? {}
        : { decimals: selection.selected.decimals }),
      sessionId: ensured.session.id,
      escrow: ensured.session.escrow,
    },
  };
}

export async function topUpFlexSession(args: {
  config: ResolvedConfig;
  session: FlexSessionRecord;
  amount: string;
  storePath?: string;
  note?: (message: string) => void;
}): Promise<{ session: FlexSessionRecord; signature: string }> {
  if (args.config.payment.family !== "solana") {
    throw new ConfigError(
      "Flex payments are only supported on Solana networks",
    );
  }
  if (args.session.status !== "open") {
    throw new Error(`Flex session ${args.session.id} is not open`);
  }
  if (args.session.owner_address !== args.config.activeWallet.address) {
    throw new Error(
      `Flex session ${args.session.id} belongs to ${args.session.owner_address}, not the active wallet`,
    );
  }
  const activeNetwork = getConfiguredSolanaNetwork(args.config);
  if (args.session.network !== activeNetwork) {
    throw new Error(
      `Flex session ${args.session.id} is for ${args.session.network}, not ${activeNetwork}`,
    );
  }

  const rpc = defaultFlexSolanaDeps.createRpc(args.config.payment.rpcURL);
  const owner = await loadOwnerSigner(args.config, defaultFlexSolanaDeps);
  args.note?.(
    `Topping up Flex session ${args.session.id} by ${formatFlexSessionAmount(args.amount, args.session)}`,
  );
  return topUpSession({
    config: args.config,
    owner,
    rpc,
    session: args.session,
    mint: args.session.mint,
    amount: args.amount,
    ...(args.storePath == null ? {} : { storePath: args.storePath }),
  });
}

export const defaultFlexSolanaDeps: FlexSolanaDeps = {
  readTextFile: fs.readFile,
  createRpc: createSolanaRpc,
  createFlexPaymentHandler,
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  generateFlexSessionKeyPair,
  getAddressFromPublicKey,
  sendInstructions,
  now: Date.now,
};
