import { option, optional } from "cmd-ts";
import { loadConfig } from "./config/load.js";
import type { OutputFormat } from "./output/format.js";

const FORMAT_VALUES = new Set(["table", "json", "yaml"]);

export const formatType = {
  async from(s: string): Promise<OutputFormat> {
    if (!FORMAT_VALUES.has(s)) {
      throw new Error(
        `Invalid format "${s}". Must be one of: table, json, yaml`,
      );
    }
    return s as OutputFormat;
  },
  description: "table, json, or yaml",
  displayName: "format",
};

export const formatFlag = option({
  type: optional(formatType),
  long: "format",
  short: "f",
  description: "Output format: table, json, yaml (default: table)",
});

export async function resolveOutputFormat(
  format: OutputFormat | undefined,
): Promise<OutputFormat> {
  if (format != null) {
    return format;
  }

  if (process.env.NO_DNA) {
    return "json";
  }

  const loaded = await loadConfig();
  return loaded?.effective.preferences.format ?? "table";
}
