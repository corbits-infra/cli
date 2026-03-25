import { option, optional } from "cmd-ts";
import type { OutputFormat } from "./output/format.js";

const FORMAT_VALUES = new Set(["table", "json", "yaml"]);

const formatType = {
  async from(s: string): Promise<OutputFormat> {
    if (!FORMAT_VALUES.has(s)) {
      throw new Error(
        `Invalid format "${s}". Must be one of: table, json, yaml`,
      );
    }
    return s as OutputFormat;
  },
  defaultValue: () => "table" as OutputFormat,
  description: "table, json, or yaml",
  displayName: "format",
};

export const formatFlag = option({
  type: optional(formatType),
  long: "format",
  short: "f",
  description: "Output format: table, json, yaml (default: table)",
});
