import { option, optional } from "cmd-ts";
import { loadConfig } from "./config/index.js";
import type { OutputFormat } from "./output/format.js";

const FORMAT_VALUES = new Set(["table", "json", "yaml"]);

export function tryParseOutputFormat(value: string): OutputFormat | undefined {
  if (!FORMAT_VALUES.has(value)) {
    return undefined;
  }
  if (value === "table" || value === "json" || value === "yaml") {
    return value;
  }
  return undefined;
}

export function isNoDnaEnabled(): boolean {
  const value = process.env.NO_DNA;
  return value != null && value !== "" && value !== "0" && value !== "false";
}

export const formatType = {
  async from(s: string): Promise<OutputFormat> {
    const format = tryParseOutputFormat(s);
    if (format != null) {
      return format;
    }
    throw new Error(`Invalid format "${s}". Must be one of: table, json, yaml`);
  },
  description: "table, json, or yaml",
  displayName: "format",
};

export const formatFlag = option({
  type: optional(formatType),
  long: "format",
  short: "f",
  description:
    "Output format: table, json, yaml (default: config or table; NO_DNA => json)",
});

export async function resolveOutputFormat(
  format: OutputFormat | undefined,
  configPath?: string,
): Promise<OutputFormat> {
  if (format != null) {
    return format;
  }

  if (isNoDnaEnabled()) {
    return "json";
  }

  const loaded = await loadConfig(configPath);
  return loaded?.resolved.preferences.format ?? "table";
}
