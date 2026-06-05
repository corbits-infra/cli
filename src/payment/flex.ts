import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, webcrypto } from "node:crypto";

import { type Address, address } from "@solana/kit";
import { normalizeNetworkId } from "@faremeter/info";
import { clusterToCAIP2 } from "@faremeter/info/solana";
import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";

import type { ResolvedConfig } from "../config/index.js";
import { getSolanaCluster } from "./networks.js";
import {
  getPaymentRequirementDetails,
  type PaymentRequirementDetails,
} from "./requirements.js";
import {
  formatPaymentRequirementMismatch,
  type PaymentRequirementSelection,
} from "./signer.js";

const FLEX_DIRECTORY_MODE = 0o700;
const FLEX_FILE_MODE = 0o600;
const FLEX_STORE_FILE = "flex-sessions.json";
const FLEX_KEY_DIRECTORY = "flex-session-keys";

type CryptoKeyPair = webcrypto.CryptoKeyPair;
type JsonWebKey = webcrypto.JsonWebKey;

export type FlexSessionStatus =
  | "open"
  | "closing"
  | "closed"
  | "needs_attention";

export type FlexSessionRecord = {
  id: string;
  status: FlexSessionStatus;
  owner_address: string;
  network: string;
  mint: string;
  facilitator: string;
  escrow: string;
  session_key_address: string;
  session_key_account: string;
  session_key_path: string;
  deposited_amount: string;
  created_at_ms: number;
  updated_at_ms: number;
  closed_at_ms?: number;
  close_error?: string;
};

export type FlexSessionStore = {
  version: 1;
  sessions: FlexSessionRecord[];
};

export type FlexRequirementDetails = PaymentRequirementDetails & {
  scheme: "flex";
  facilitator: string;
  minGracePeriodSlots: bigint;
};

export type FlexRequirementSelection =
  | {
      kind: "selected";
      activeNetwork: string;
      requestedAsset: string;
      selected: FlexRequirementDetails;
    }
  | Exclude<PaymentRequirementSelection, { kind: "selected" }>;

export type FlexSessionReadiness =
  | {
      kind: "ready";
      session: FlexSessionRecord;
      availableAmount: string;
      vaultBalanceAmount: string;
      pendingAmount: string;
    }
  | {
      kind: "underfunded";
      session: FlexSessionRecord;
      availableAmount: string;
      vaultBalanceAmount: string;
      pendingAmount: string;
      shortfallAmount: string;
    }
  | {
      kind: "unusable";
      session: FlexSessionRecord;
      issue: string;
    };

export type FlexSessionRuntimeView = {
  session: FlexSessionRecord;
  availableAmount?: string;
  vaultBalanceAmount?: string;
  pendingAmount?: string;
  issue?: string;
};

export type FlexSessionKeyMaterial = JsonWebKey;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function addBaseUnits(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

export function compareBaseUnitAmounts(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? 1 : -1;
}

export function parsePositiveBaseUnitAmount(
  name: string,
  value: string,
): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer base-unit amount`);
  }
  const normalized = trimmed.replace(/^0+(?=\d)/, "");
  if (normalized === "0") {
    throw new Error(`${name} must be greater than zero`);
  }
  return normalized;
}

export function subtractBaseUnits(left: string, right: string): string {
  const result = BigInt(left) - BigInt(right);
  return result > 0n ? result.toString() : "0";
}

function parseMinGracePeriodSlots(extra: Record<string, unknown>): bigint {
  const value = extra.minGracePeriodSlots;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return 150n;
}

export function isFlexScheme(scheme: string): boolean {
  return scheme === "flex" || scheme === "@faremeter/flex";
}

export function getConfiguredSolanaNetwork(config: ResolvedConfig): string {
  return clusterToCAIP2(getSolanaCluster(config)).caip2;
}

export function isFlexSessionEligibleForTopup(
  session: FlexSessionRecord,
  config: ResolvedConfig,
): boolean {
  return (
    session.status === "open" &&
    session.owner_address === config.activeWallet.address &&
    session.network === getConfiguredSolanaNetwork(config)
  );
}

export function isFlexRequirement(
  detail: PaymentRequirementDetails,
): detail is FlexRequirementDetails {
  const extra = detail.requirement.extra;
  if (!isFlexScheme(detail.scheme) || !isRecord(extra)) {
    return false;
  }

  return typeof extra.facilitator === "string" && extra.facilitator.length > 0;
}

function toFlexRequirement(
  detail: PaymentRequirementDetails,
): FlexRequirementDetails | null {
  if (!isFlexRequirement(detail)) {
    return null;
  }
  const extra = detail.requirement.extra as Record<string, unknown>;

  return {
    ...detail,
    scheme: "flex",
    facilitator: String(extra.facilitator),
    minGracePeriodSlots: parseMinGracePeriodSlots(extra),
  };
}

function dedupeFlexOptions(
  options: FlexRequirementDetails[],
): FlexRequirementDetails[] {
  const seen = new Set<string>();
  const deduped: FlexRequirementDetails[] = [];
  for (const option of options) {
    const key = `${option.network}:${option.asset}:${option.facilitator}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }
  return deduped;
}

export function hasFlexRequirements(
  accepts: x402PaymentRequirementsV2[],
): boolean {
  return getPaymentRequirementDetails(accepts).some(
    (detail) => toFlexRequirement(detail) != null,
  );
}

export function selectFlexRequirement(args: {
  accepts: x402PaymentRequirementsV2[];
  config: ResolvedConfig;
}): FlexRequirementSelection {
  const requestedAsset = args.config.payment.asset;
  const activeNetwork = getConfiguredSolanaNetwork(args.config);
  const options = getPaymentRequirementDetails(args.accepts)
    .map(toFlexRequirement)
    .filter((detail) => detail != null);

  const activeNetworkOptions = dedupeFlexOptions(
    options.filter((option) => option.network === activeNetwork),
  );
  if (activeNetworkOptions.length === 0) {
    return {
      kind: "network-mismatch",
      activeNetwork,
      requestedAsset,
      options,
    };
  }

  const symbolMatches = activeNetworkOptions.filter(
    (option) => option.symbol?.toLowerCase() === requestedAsset.toLowerCase(),
  );
  if (symbolMatches.length === 1) {
    const selected = symbolMatches[0];
    if (selected == null) {
      throw new Error("expected exactly one selected Flex requirement");
    }
    return {
      kind: "selected",
      activeNetwork,
      requestedAsset,
      selected,
    };
  }

  if (symbolMatches.length > 1) {
    return {
      kind: "asset-ambiguous",
      activeNetwork,
      requestedAsset,
      matches: symbolMatches,
    };
  }

  return {
    kind: "asset-mismatch",
    activeNetwork,
    requestedAsset,
    options: activeNetworkOptions,
  };
}

export function formatFlexRequirementMismatch(
  config: ResolvedConfig,
  selection: Exclude<FlexRequirementSelection, { kind: "selected" }>,
): string {
  return formatPaymentRequirementMismatch(config, selection);
}

function getFlexBaseDirectory(): string {
  const base =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "corbits");
}

export function getFlexSessionStorePath(storePath?: string): string {
  return storePath ?? path.join(getFlexBaseDirectory(), FLEX_STORE_FILE);
}

export function getFlexSessionKeyPath(id: string, storePath?: string): string {
  return path.join(
    path.dirname(getFlexSessionStorePath(storePath)),
    FLEX_KEY_DIRECTORY,
    `${id}.jwk`,
  );
}

function normalizeSessionStore(value: unknown): FlexSessionStore {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.sessions)
  ) {
    return { version: 1, sessions: [] };
  }

  const sessions = value.sessions.filter(isFlexSessionRecord);
  return { version: 1, sessions };
}

function isFlexSessionRecord(value: unknown): value is FlexSessionRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    ["open", "closing", "closed", "needs_attention"].includes(value.status) &&
    typeof value.owner_address === "string" &&
    typeof value.network === "string" &&
    typeof value.mint === "string" &&
    typeof value.facilitator === "string" &&
    typeof value.escrow === "string" &&
    typeof value.session_key_address === "string" &&
    typeof value.session_key_account === "string" &&
    typeof value.session_key_path === "string" &&
    typeof value.deposited_amount === "string" &&
    typeof value.created_at_ms === "number" &&
    typeof value.updated_at_ms === "number"
  );
}

export async function readFlexSessionStore(
  storePath?: string,
): Promise<FlexSessionStore> {
  try {
    const text = await fs.readFile(getFlexSessionStorePath(storePath), "utf8");
    return normalizeSessionStore(JSON.parse(text) as unknown);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return { version: 1, sessions: [] };
    }
    throw err;
  }
}

export async function writeFlexSessionStore(
  store: FlexSessionStore,
  storePath?: string,
): Promise<void> {
  const targetPath = getFlexSessionStorePath(storePath);
  await fs.mkdir(path.dirname(targetPath), {
    recursive: true,
    mode: FLEX_DIRECTORY_MODE,
  });
  await fs.writeFile(targetPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: FLEX_FILE_MODE,
  });
}

export async function upsertFlexSessionRecord(
  record: FlexSessionRecord,
  storePath?: string,
): Promise<void> {
  const store = await readFlexSessionStore(storePath);
  const index = store.sessions.findIndex((session) => session.id === record.id);
  const next = { ...record, updated_at_ms: Date.now() };
  if (index === -1) {
    store.sessions.push(next);
  } else {
    store.sessions[index] = next;
  }
  await writeFlexSessionStore(store, storePath);
}

export async function createFlexSessionRecord(args: {
  ownerAddress: string;
  network: string;
  mint: string;
  facilitator: string;
  escrow: string;
  sessionKeyAddress: string;
  sessionKeyAccount: string;
  depositedAmount: string;
  storePath?: string;
}): Promise<FlexSessionRecord> {
  const id = randomUUID();
  const now = Date.now();
  const record: FlexSessionRecord = {
    id,
    status: "open",
    owner_address: args.ownerAddress,
    network: normalizeNetworkId(args.network),
    mint: args.mint,
    facilitator: args.facilitator,
    escrow: args.escrow,
    session_key_address: args.sessionKeyAddress,
    session_key_account: args.sessionKeyAccount,
    session_key_path: getFlexSessionKeyPath(id, args.storePath),
    deposited_amount: args.depositedAmount,
    created_at_ms: now,
    updated_at_ms: now,
  };
  await upsertFlexSessionRecord(record, args.storePath);
  return record;
}

export function findMatchingFlexSessions(args: {
  sessions: FlexSessionRecord[];
  ownerAddress: string;
  network: string;
  mint: string;
  facilitator: string;
}): FlexSessionRecord[] {
  const network = normalizeNetworkId(args.network);
  return args.sessions.filter(
    (session) =>
      session.status === "open" &&
      session.owner_address === args.ownerAddress &&
      session.network === network &&
      session.mint === args.mint &&
      session.facilitator === args.facilitator,
  );
}

export async function writeFlexSessionKeyMaterial(
  record: FlexSessionRecord,
  keyPair: CryptoKeyPair,
): Promise<void> {
  const jwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  await fs.mkdir(path.dirname(record.session_key_path), {
    recursive: true,
    mode: FLEX_DIRECTORY_MODE,
  });
  await fs.writeFile(record.session_key_path, `${JSON.stringify(jwk)}\n`, {
    encoding: "utf8",
    mode: FLEX_FILE_MODE,
  });
}

export async function readFlexSessionKeyPair(
  record: FlexSessionRecord,
): Promise<CryptoKeyPair> {
  const text = await fs.readFile(record.session_key_path, "utf8");
  const jwk = JSON.parse(text) as JsonWebKey;
  if (jwk.kty == null || jwk.crv == null || jwk.x == null) {
    throw new Error(`Flex session key ${record.id} is missing public key data`);
  }
  const privateKey = await webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const publicJwk: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    key_ops: ["verify"],
    ext: true,
  };
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return { privateKey, publicKey };
}

export async function generateFlexSessionKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

export function toSolanaAddress(value: string): Address {
  return address(value);
}

export function applyFlexDeposit(
  session: FlexSessionRecord,
  amount: string,
): FlexSessionRecord {
  return {
    ...session,
    deposited_amount: addBaseUnits(session.deposited_amount, amount),
    updated_at_ms: Date.now(),
  };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}
