import Table from "cli-table3";
import { stringify as yamlStringify } from "yaml";

export type OutputFormat = "table" | "json" | "yaml";

export function writeLine(s: string): void {
  process.stdout.write(s + "\n");
}

export function printJson(data: unknown): void {
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

export function printFormatted<T>(
  format: OutputFormat,
  data: T[],
  head: string[],
  toRow: (item: T) => string[],
): void {
  if (format === "json") {
    printJson(data);
    return;
  }
  if (format === "yaml") {
    printYaml(data);
    return;
  }
  printTable(head, data.map(toRow));
}
