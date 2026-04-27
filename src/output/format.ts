import Table from "cli-table3";
import { stringify as yamlStringify } from "yaml";

export type OutputFormat = "table" | "json" | "yaml";

export function writeLine(s: string): void {
  process.stdout.write(s + "\n");
}

export function writeStderrLine(s: string): void {
  process.stderr.write(s + "\n");
}

export function printJSON(data: unknown): void {
  writeLine(JSON.stringify(data, null, 2));
}

export function printYaml(data: unknown): void {
  writeLine(yamlStringify(data));
}

export function printTable(head: string[], rows: string[][]): void {
  const table = new Table({
    head,
    style: {
      head: [],
      border: [],
    },
  });
  for (const row of rows) {
    table.push(row);
  }
  writeLine(table.toString());
}

export function formatPrice(microUsdc: number): string {
  return `$${(microUsdc / 1_000_000).toFixed(6)}`;
}

export function formatTokenAmount(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!/^\d+$/.test(normalized)) {
    return amount;
  }

  const whole = normalized.padStart(decimals + 1, "0");
  const splitIndex = whole.length - decimals;
  const integerPart = whole.slice(0, splitIndex);
  if (decimals === 0) {
    return integerPart;
  }
  const fractionalPart = whole.slice(splitIndex);
  return `${integerPart}.${fractionalPart}`;
}

export function formatDisplayTokenAmount(args: {
  amount: string;
  asset: string;
  decimals?: number | null;
}): string {
  const decimals = args.decimals ?? (args.asset === "USDC" ? 6 : undefined);
  return decimals == null
    ? args.amount
    : formatTokenAmount(args.amount, decimals);
}

export function tryParseJSON(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function printFormatted<T>(
  format: OutputFormat,
  data: T[],
  head: string[],
  toRow: (item: T) => string[],
): void {
  if (format === "json") {
    printJSON(data);
    return;
  }
  if (format === "yaml") {
    printYaml(data);
    return;
  }
  printTable(head, data.map(toRow));
}
