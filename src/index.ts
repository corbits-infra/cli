#!/usr/bin/env node

import { createRequire } from "node:module";
import { subcommands, run } from "cmd-ts";
import { balance } from "./commands/balance.js";
import { call } from "./commands/call.js";
import { config } from "./commands/config.js";
import { discover } from "./commands/discover.js";
import { history } from "./commands/history.js";
import { inspect } from "./commands/inspect.js";
import { APIError, ValidationError } from "./api/client.js";
import { ConfigError } from "./config/index.js";

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

const app = subcommands({
  name: "corbits",
  version: pkg.version,
  description: "Browse, filter, and test x402-gated services",
  cmds: { discover, inspect, config, call, balance, history },
});

run(app, process.argv.slice(2)).catch((err: unknown) => {
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
});
