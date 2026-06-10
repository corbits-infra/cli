#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg: unknown = require("../package.json");

function isPackageMetadata(value: unknown): value is { version: string } {
  return (
    value != null &&
    typeof value === "object" &&
    "version" in value &&
    typeof value.version === "string"
  );
}

if (!isPackageMetadata(pkg)) {
  throw new Error("package metadata is missing a string version");
}

/* eslint-disable no-console */
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (
    args.length === 1 &&
    args[0] ===
      "bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)"
  ) {
    return;
  }

  originalConsoleWarn(...args);
};
/* eslint-enable no-console */

const { subcommands, run } = await import("cmd-ts");
const { balance } = await import("./commands/balance.js");
const { call } = await import("./commands/call.js");
const { config } = await import("./commands/config.js");
const { discover } = await import("./commands/discover.js");
const { flex } = await import("./commands/flex.js");
const { history } = await import("./commands/history.js");
const { inspect } = await import("./commands/inspect.js");
const { APIError, ValidationError } = await import("./api/client.js");
const { ConfigError } = await import("./config/index.js");
const { formatSectionTitle, formatStatus, printBrandHeader } =
  await import("./output/brand.js");

function printWelcome(version: string): void {
  printBrandHeader();
  process.stdout.write(
    [
      formatSectionTitle("Corbits CLI"),
      formatStatus(
        "Discover services, configure payments, and call APIs from your terminal",
      ),
      `Version: ${version}`,
      "",
      "Start with:",
      "  corbits discover",
      "  corbits config init --network <name> --solana-address <addr> --solana-path <path>",
      "  corbits call --inspect -- curl <url>",
      "",
      "Run `corbits --help` for all commands.",
    ].join("\n") + "\n",
  );
}

const app = subcommands({
  name: "corbits",
  version: pkg.version,
  description:
    "Discover services, configure payments, and call APIs from your terminal",
  cmds: { discover, inspect, config, call, balance, history, flex },
});

const args = process.argv.slice(2);

function handleRunError(err: unknown): void {
  if (err instanceof APIError) {
    process.stderr.write(`API error (${String(err.status)}): ${err.message}\n`);
  } else if (err instanceof ValidationError) {
    process.stderr.write(`Unexpected API response: ${err.message}\n`);
  } else if (err instanceof ConfigError) {
    process.stderr.write(`Config error: ${err.message}\n`);
  } else {
    const message =
      err instanceof Error
        ? err.message.length > 0
          ? err.message
          : err.name
        : String(err);
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
}

if (args.length === 0) {
  printWelcome(pkg.version);
} else {
  run(app, args).catch(handleRunError);
}
