import { command, option, optional, positional, string } from "cmd-ts";
import { TextDecoder } from "node:util";
import { formatFlag, resolveOutputFormat } from "../flags.js";
import {
  listHistoryEntries,
  readHistoryEntry,
  type HistoryEntry,
} from "../history/store.js";
import {
  formatDisplayTokenAmount,
  printJson,
  printTable,
  printYaml,
  type OutputFormat,
  writeLine,
} from "../output/format.js";

type HistoryCommandDeps = {
  listHistoryEntries: typeof listHistoryEntries;
  readHistoryEntry: typeof readHistoryEntry;
};

type HistoryCommandArgs = {
  action: string | undefined;
  index: string | undefined;
  format: OutputFormat | undefined;
  wallet: string | undefined;
  network: string | undefined;
  host: string | undefined;
  resource: string | undefined;
  minAmount: string | undefined;
  maxAmount: string | undefined;
  since: string | undefined;
  until: string | undefined;
  limit: string | undefined;
};

function parsePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseAmountFilter(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a base-unit integer`);
  }

  return BigInt(value);
}

function parseTimeFilter(name: string, value: string): number {
  const normalized = value.trim();

  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `${name} must be Unix seconds, Unix milliseconds, or ISO datetime`,
      );
    }

    return normalized.length <= 10 ? parsed * 1000 : parsed;
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `${name} must be Unix seconds, Unix milliseconds, or ISO datetime`,
    );
  }

  return parsed;
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatResponseStatus(status: number | null): string {
  return status == null ? "unknown" : `HTTP ${status}`;
}

function decodeHistoryResponse(response: Uint8Array): {
  text?: string;
  base64?: string;
} {
  try {
    return {
      text: new TextDecoder("utf8", { fatal: true }).decode(response),
    };
  } catch {
    return { base64: Buffer.from(response).toString("base64") };
  }
}

function writeResponseText(response: string): void {
  process.stdout.write(response);
  if (!response.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function formatHistoryAmount(entry: HistoryEntry): string {
  const assetDisplay = entry.record.asset_symbol ?? entry.record.asset;
  const amount = formatDisplayTokenAmount({
    amount: entry.record.amount,
    asset: assetDisplay,
    ...(entry.record.decimals == null
      ? {}
      : { decimals: entry.record.decimals }),
  });
  return `${amount} ${assetDisplay}`;
}

function hasListFilters(args: HistoryCommandArgs): boolean {
  return (
    args.wallet != null ||
    args.network != null ||
    args.host != null ||
    args.resource != null ||
    args.minAmount != null ||
    args.maxAmount != null ||
    args.since != null ||
    args.until != null ||
    args.limit != null
  );
}

function printHistoryList(format: OutputFormat, entries: HistoryEntry[]): void {
  if (format === "json") {
    printJson(
      entries.map((entry) => ({ index: entry.index, ...entry.record })),
    );
    return;
  }

  if (format === "yaml") {
    printYaml(
      entries.map((entry) => ({ index: entry.index, ...entry.record })),
    );
    return;
  }

  if (entries.length === 0) {
    writeLine("No history entries found.");
    return;
  }

  printTable(
    [
      "#",
      "Time",
      "Method",
      "Host",
      "Resource",
      "Amount",
      "Network",
      "Wallet",
      "Status",
    ],
    entries.map((entry) => [
      String(entry.index),
      formatTimestamp(entry.record.timestamp_ms),
      entry.record.method,
      entry.record.host,
      entry.record.resource_path,
      formatHistoryAmount(entry),
      entry.record.network,
      entry.record.wallet_address,
      formatResponseStatus(entry.record.response_status),
    ]),
  );
}

function printHistoryDetail(format: OutputFormat, entry: HistoryEntry): void {
  const decodedResponse =
    entry.response == null ? undefined : decodeHistoryResponse(entry.response);
  const detail =
    decodedResponse == null
      ? entry.record
      : decodedResponse.text != null
        ? { ...entry.record, response: decodedResponse.text }
        : {
            ...entry.record,
            response_base64: decodedResponse.base64,
            response_encoding: "base64",
          };

  if (format === "json") {
    printJson(detail);
    return;
  }

  if (format === "yaml") {
    printYaml(detail);
    return;
  }

  printTable(
    ["Field", "Value"],
    [
      ["#", String(entry.index)],
      ["timestamp", formatTimestamp(entry.record.timestamp_ms)],
      ["tool", entry.record.tool],
      ["method", entry.record.method],
      ["url", entry.record.url],
      ["host", entry.record.host],
      ["resource_path", entry.record.resource_path],
      ["response_status", formatResponseStatus(entry.record.response_status)],
      ["payment_status", entry.record.payment_status],
      ["amount", formatHistoryAmount(entry)],
      ["asset", entry.record.asset],
      ...(entry.record.asset_symbol == null
        ? []
        : [["asset_symbol", entry.record.asset_symbol]]),
      ["network", entry.record.network],
      ["wallet_address", entry.record.wallet_address],
      ["wallet_kind", entry.record.wallet_kind],
      ...(entry.record.tx_signature == null
        ? []
        : [["tx_signature", entry.record.tx_signature]]),
    ],
  );

  if (entry.response == null) {
    return;
  }

  writeLine("");
  if (decodedResponse?.text != null) {
    writeLine("Response:");
    writeResponseText(decodedResponse.text);
    return;
  }

  writeLine("Response (base64):");
  writeLine(decodedResponse?.base64 ?? "");
}

export function createHistoryCommand(deps: HistoryCommandDeps) {
  return command({
    name: "history",
    description: "Inspect saved paid-call history",
    args: {
      action: positional({ type: optional(string), displayName: "show" }),
      index: positional({ type: optional(string), displayName: "index" }),
      format: formatFlag,
      wallet: option({
        type: optional(string),
        long: "wallet",
        description: "Filter by wallet address substring",
      }),
      network: option({
        type: optional(string),
        long: "network",
        description: "Filter by network substring",
      }),
      host: option({
        type: optional(string),
        long: "host",
        description: "Filter by host substring",
      }),
      resource: option({
        type: optional(string),
        long: "resource",
        description: "Filter by resource path substring",
      }),
      minAmount: option({
        type: optional(string),
        long: "min-amount",
        description: "Minimum paid amount in base integer units",
      }),
      maxAmount: option({
        type: optional(string),
        long: "max-amount",
        description: "Maximum paid amount in base integer units",
      }),
      since: option({
        type: optional(string),
        long: "since",
        description: "Lower time bound: Unix seconds, Unix ms, or ISO datetime",
      }),
      until: option({
        type: optional(string),
        long: "until",
        description: "Upper time bound: Unix seconds, Unix ms, or ISO datetime",
      }),
      limit: option({
        type: optional(string),
        long: "limit",
        description: "Maximum number of rows to show (default: 20)",
      }),
    },
    handler: async (args) => {
      const format = await resolveOutputFormat(args.format);

      if (args.action == null) {
        const entries = await deps.listHistoryEntries({
          ...(args.wallet == null ? {} : { wallet: args.wallet }),
          ...(args.network == null ? {} : { network: args.network }),
          ...(args.host == null ? {} : { host: args.host }),
          ...(args.resource == null ? {} : { resource: args.resource }),
          ...(args.minAmount == null
            ? {}
            : { minAmount: parseAmountFilter("--min-amount", args.minAmount) }),
          ...(args.maxAmount == null
            ? {}
            : { maxAmount: parseAmountFilter("--max-amount", args.maxAmount) }),
          ...(args.since == null
            ? {}
            : { since: parseTimeFilter("--since", args.since) }),
          ...(args.until == null
            ? {}
            : { until: parseTimeFilter("--until", args.until) }),
          limit:
            args.limit == null
              ? 20
              : parsePositiveInteger("--limit", args.limit),
        });
        printHistoryList(format, entries);
        return;
      }

      if (args.action !== "show") {
        throw new Error(`Unknown history subcommand "${args.action}"`);
      }

      if (hasListFilters(args)) {
        throw new Error("history show only accepts --format");
      }

      if (args.index == null) {
        throw new Error("history show requires <index>");
      }

      const index = parsePositiveInteger("history index", args.index);
      const entry = await deps.readHistoryEntry(index);
      if (entry == null) {
        throw new Error(`History entry #${index} not found`);
      }

      printHistoryDetail(format, entry);
    },
  });
}

export const history = createHistoryCommand({
  listHistoryEntries,
  readHistoryEntry,
});
