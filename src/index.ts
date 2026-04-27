#!/usr/bin/env node

import { createRequire } from "node:module";
import { subcommands, run } from "cmd-ts";
import { config } from "./commands/config.js";
import { discover } from "./commands/discover.js";
import { inspect } from "./commands/inspect.js";
import { ApiError, ValidationError } from "./api/client.js";
import { ConfigError } from "./config/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const app = subcommands({
  name: "corbits",
  version: pkg.version,
  description: "Browse, filter, and test x402-gated services",
  cmds: { discover, inspect, config },
});

run(app, process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ApiError) {
    process.stderr.write(`API error (${String(err.status)}): ${err.message}\n`);
  } else if (err instanceof ValidationError) {
    process.stderr.write(`Unexpected API response: ${err.message}\n`);
  } else if (err instanceof ConfigError) {
    process.stderr.write(`Config error: ${err.message}\n`);
  } else {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exitCode = 1;
});
