import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type } from "arktype";
import type { ResolvedConfig } from "../config/index.js";
import type { WrappedClient } from "../process/wrapped-client.js";

const HISTORY_RESPONSE_DIRECTORY = "history-responses";

const HistoryRecordSchema = type({
  "+": "reject",
  id: "string",
  timestamp_ms: "number",
  tool: "'curl' | 'wget'",
  method: "string",
  url: "string",
  host: "string",
  resource_path: "string",
  response_status: "number | null",
  payment_status: "'paid'",
  amount: "string",
  asset: "string",
  "asset_symbol?": "string",
  "decimals?": "number",
  network: "string",
  wallet_address: "string",
  wallet_kind: "'keypair' | 'ows'",
  "tx_signature?": "string",
  "response_path?": "string",
});

export type HistoryRecord = typeof HistoryRecordSchema.infer;

export type HistoryEntry = {
  index: number;
  record: HistoryRecord;
  response?: Uint8Array;
};

export type HistoryWriteInput = {
  tool: WrappedClient;
  method?: string;
  url: string;
  responseStatus: number | null;
  amount: string;
  asset: string;
  assetSymbol?: string;
  decimals?: number;
  //TODO: need to type this out
  network: string;
  walletAddress: string;
  walletKind: ResolvedConfig["activeWallet"]["kind"];
  txSignature?: string;
};

export type HistoryAppendArgs = {
  historyPath?: string;
  responseBody?: Uint8Array | string;
};

export type HistoryListFilters = {
  wallet?: string;
  network?: string;
  host?: string;
  resource?: string;
  minAmount?: bigint;
  maxAmount?: bigint;
  since?: number;
  until?: number;
  limit?: number;
};

export function getHistoryPath(historyPath?: string): string {
  if (historyPath != null) {
    return historyPath;
  }

  const base =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "corbits", "history.jsonl");
}

export function createHistoryRecord(args: HistoryWriteInput): HistoryRecord {
  const parsedURL = new URL(args.url);
  const result = HistoryRecordSchema({
    id: randomUUID(),
    timestamp_ms: Date.now(),
    tool: args.tool,
    method: (args.method ?? "GET").toUpperCase(),
    url: args.url,
    host: parsedURL.host,
    resource_path: `${parsedURL.pathname}${parsedURL.search}`,
    response_status: args.responseStatus,
    payment_status: "paid",
    amount: args.amount,
    asset: args.asset,
    ...(args.assetSymbol == null ? {} : { asset_symbol: args.assetSymbol }),
    ...(args.decimals == null ? {} : { decimals: args.decimals }),
    network: args.network,
    wallet_address: args.walletAddress,
    wallet_kind: args.walletKind,
    ...(args.txSignature == null ? {} : { tx_signature: args.txSignature }),
  });

  if (result instanceof type.errors) {
    throw new Error(`Invalid history record: ${result.summary}`);
  }

  return result as HistoryRecord;
}

export async function appendHistoryRecord(
  record: HistoryRecord,
  args: HistoryAppendArgs = {},
): Promise<void> {
  const targetPath = getHistoryPath(args.historyPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (args.responseBody == null) {
    await fs.appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8");
    return;
  }

  const responsePath = await writeHistoryResponse(
    record.id,
    args.responseBody,
    args.historyPath,
  );
  const storedRecord = HistoryRecordSchema({
    ...record,
    response_path: responsePath,
  });

  if (storedRecord instanceof type.errors) {
    await deleteHistoryResponse(responsePath, args.historyPath);
    throw new Error(`Invalid history record: ${storedRecord.summary}`);
  }

  try {
    await fs.appendFile(
      targetPath,
      `${JSON.stringify(storedRecord)}\n`,
      "utf8",
    );
  } catch (cause) {
    await deleteHistoryResponse(responsePath, args.historyPath);
    throw cause;
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

function parseHistoryRecord(line: string): HistoryRecord | null {
  if (line.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const result = HistoryRecordSchema(parsed);
  if (result instanceof type.errors) {
    return null;
  }

  return result as HistoryRecord;
}

function parseHistoryRecordOrThrow(line: string, index: number): HistoryRecord {
  if (line.trim().length === 0) {
    throw new Error(`History entry #${index} is malformed`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error(`History entry #${index} is malformed`, { cause });
  }

  const result = HistoryRecordSchema(parsed);
  if (result instanceof type.errors) {
    throw new Error(`History entry #${index} is malformed`);
  }

  return result as HistoryRecord;
}

function getHistoryDirectory(historyPath?: string): string {
  return path.dirname(getHistoryPath(historyPath));
}

function getHistoryResponseDirectory(historyPath?: string): string {
  return path.join(
    getHistoryDirectory(historyPath),
    HISTORY_RESPONSE_DIRECTORY,
  );
}

function getHistoryResponseRelativePath(recordId: string): string {
  return path.join(HISTORY_RESPONSE_DIRECTORY, `${recordId}.txt`);
}

function resolveHistoryResponsePath(
  responsePath: string,
  historyPath?: string,
): string {
  return path.resolve(getHistoryDirectory(historyPath), responsePath);
}

function resolveStoredHistoryResponsePath(
  responsePath: string,
  index: number,
  historyPath?: string,
): string {
  if (path.isAbsolute(responsePath)) {
    throw new Error(`Saved response for history entry #${index} is invalid`);
  }

  const targetPath = resolveHistoryResponsePath(responsePath, historyPath);
  const responseDirectory = path.resolve(
    getHistoryResponseDirectory(historyPath),
  );
  const relativePath = path.relative(responseDirectory, targetPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Saved response for history entry #${index} is invalid`);
  }

  return targetPath;
}

async function writeHistoryResponse(
  recordId: string,
  responseBody: Uint8Array | string,
  historyPath?: string,
): Promise<string> {
  const responsePath = getHistoryResponseRelativePath(recordId);
  const targetPath = resolveHistoryResponsePath(responsePath, historyPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, responseBody);
  return responsePath;
}

async function deleteHistoryResponse(
  responsePath: string,
  historyPath?: string,
): Promise<void> {
  await fs.rm(resolveHistoryResponsePath(responsePath, historyPath), {
    force: true,
  });
}

async function readHistoryText(historyPath?: string): Promise<string | null> {
  try {
    return await fs.readFile(getHistoryPath(historyPath), "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

async function readHistoryResponse(
  record: HistoryRecord,
  index: number,
  historyPath?: string,
): Promise<Uint8Array | null> {
  if (record.response_path == null) {
    return null;
  }

  const targetPath = resolveStoredHistoryResponsePath(
    record.response_path,
    index,
    historyPath,
  );

  try {
    return await fs.readFile(targetPath);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) {
      throw new Error(`Saved response for history entry #${index} is missing`, {
        cause,
      });
    }

    throw new Error(
      `Failed to read saved response for history entry #${index}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function splitHistoryLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function includesIgnoreCase(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function parseBaseAmount(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return BigInt(normalized);
}

function matchesFilters(
  entry: HistoryEntry,
  filters: HistoryListFilters,
): boolean {
  const { record } = entry;

  if (
    filters.wallet != null &&
    !includesIgnoreCase(record.wallet_address, filters.wallet)
  ) {
    return false;
  }

  if (
    filters.network != null &&
    !includesIgnoreCase(record.network, filters.network)
  ) {
    return false;
  }

  if (filters.host != null && !includesIgnoreCase(record.host, filters.host)) {
    return false;
  }

  if (
    filters.resource != null &&
    !includesIgnoreCase(record.resource_path, filters.resource)
  ) {
    return false;
  }

  if (
    (filters.minAmount != null || filters.maxAmount != null) &&
    parseBaseAmount(record.amount) == null
  ) {
    return false;
  }

  const amount = parseBaseAmount(record.amount);
  if (
    filters.minAmount != null &&
    amount != null &&
    amount < filters.minAmount
  ) {
    return false;
  }

  if (
    filters.maxAmount != null &&
    amount != null &&
    amount > filters.maxAmount
  ) {
    return false;
  }

  if (filters.since != null && record.timestamp_ms < filters.since) {
    return false;
  }

  if (filters.until != null && record.timestamp_ms > filters.until) {
    return false;
  }

  return true;
}

export async function listHistoryEntries(
  filters: HistoryListFilters = {},
  historyPath?: string,
): Promise<HistoryEntry[]> {
  const text = await readHistoryText(historyPath);
  if (text == null || text.length === 0) {
    return [];
  }

  const entries: HistoryEntry[] = [];

  for (const [offset, line] of splitHistoryLines(text).entries()) {
    const record = parseHistoryRecord(line);
    if (record == null) {
      continue;
    }

    const entry = { index: offset + 1, record };
    if (matchesFilters(entry, filters)) {
      entries.push(entry);
    }
  }

  entries.sort(
    (left, right) => right.record.timestamp_ms - left.record.timestamp_ms,
  );

  return filters.limit == null ? entries : entries.slice(0, filters.limit);
}

export async function readHistoryEntry(
  index: number,
  historyPath?: string,
): Promise<HistoryEntry | null> {
  const text = await readHistoryText(historyPath);
  if (text == null || text.length === 0) {
    return null;
  }

  const line = splitHistoryLines(text)[index - 1];
  if (line == null) {
    return null;
  }

  const record = parseHistoryRecordOrThrow(line, index);
  const response = await readHistoryResponse(record, index, historyPath);
  return response == null ? { index, record } : { index, record, response };
}
