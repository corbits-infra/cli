#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import t from "tap";
import { config as configCommand } from "../src/commands/config.js";
import { expandHome, getConfigPath } from "../src/config/path.js";
import {
  type CorbitsConfig,
  ConfigError,
  parseConfig,
  resolveEffectiveConfig,
  stringifyConfig,
} from "../src/config/schema.js";
import { captureStdout } from "./helpers.js";

function withTempConfigHome(test: {
  teardown(fn: () => Promise<void>): void;
}): string {
  const dir = path.join(
    os.tmpdir(),
    `corbits-config-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.XDG_CONFIG_HOME = dir;
  test.teardown(async () => {
    delete process.env.XDG_CONFIG_HOME;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function readConfigFile(configHome: string): Promise<string> {
  return fs.readFile(path.join(configHome, "corbits", "config.toml"), "utf8");
}

await t.test("config path helpers", async (t) => {
  await t.test("uses XDG config home when present", async (t) => {
    t.equal(
      getConfigPath({ ...process.env, XDG_CONFIG_HOME: "/tmp/corbits-xdg" }),
      path.join("/tmp/corbits-xdg", "corbits", "config.toml"),
    );
    t.end();
  });

  await t.test("falls back to ~/.config", async (t) => {
    t.equal(
      getConfigPath({}),
      path.join(os.homedir(), ".config", "corbits", "config.toml"),
    );
    t.end();
  });

  await t.test("expands home directory markers", async (t) => {
    t.equal(
      expandHome("~/keys/demo.key"),
      path.join(os.homedir(), "keys/demo.key"),
    );
    t.end();
  });
});

await t.test("config schema", async (t) => {
  const sample = `version = 1
active_network = "solana-mainnet"

[preferences]
format = "table"
api_url = "https://api.corbits.dev"

[networks.solana-mainnet]
address = "7xKX..."
keyfile = "~/.config/corbits/keys/solana.key"
`;

  await t.test("parses valid TOML and resolves active account", async (t) => {
    const parsed = parseConfig(sample);
    const effective = resolveEffectiveConfig(parsed);
    t.equal(parsed.active_network, "solana-mainnet");
    t.equal(effective.activeAccount.address, "7xKX...");
    t.equal(
      effective.activeAccount.expandedKeyfile,
      path.join(os.homedir(), ".config/corbits/keys/solana.key"),
    );
    t.match(stringifyConfig(parsed), /version = 1/);
    t.end();
  });

  await t.test("rejects malformed TOML", async (t) => {
    t.throws(
      () => parseConfig('version = 1\nactive_network = "x"\n['),
      ConfigError,
    );
    t.end();
  });

  await t.test("rejects invalid version", async (t) => {
    t.throws(
      () => parseConfig(sample.replace("version = 1", "version = 2")),
      /version must be 1/,
    );
    t.end();
  });

  await t.test("rejects invalid format", async (t) => {
    t.throws(
      () => parseConfig(sample.replace('format = "table"', 'format = "xml"')),
      /preferences\.format/,
    );
    t.end();
  });

  await t.test("rejects invalid api url", async (t) => {
    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'api_url = "https://api.corbits.dev"',
            'api_url = "not-a-url"',
          ),
        ),
      /preferences\.api_url/,
    );
    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'api_url = "https://api.corbits.dev"',
            'api_url = "ftp://example.com"',
          ),
        ),
      /preferences\.api_url/,
    );
    t.end();
  });

  await t.test("rejects missing active network entry", async (t) => {
    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'active_network = "solana-mainnet"',
            'active_network = "base"',
          ),
        ),
      /active_network "base"/,
    );
    t.end();
  });

  await t.test("rejects blank address and keyfile", async (t) => {
    t.throws(
      () => parseConfig(sample.replace('address = "7xKX..."', 'address = ""')),
      /address must be non-empty/,
    );
    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'keyfile = "~/.config/corbits/keys/solana.key"',
            'keyfile = ""',
          ),
        ),
      /keyfile must be non-empty/,
    );
    t.end();
  });
});

await t.test("config command", async (t) => {
  await t.test(
    "reports uninitialized state when config is missing",
    async (t) => {
      withTempConfigHome(t);
      const output = await captureStdout(() =>
        configCommand.handler({
          action: undefined,
          target: undefined,
          value: undefined,
          network: undefined,
          address: undefined,
          keyfile: undefined,
          format: undefined,
          apiUrl: undefined,
        }),
      );
      t.match(output, /config: not initialized/);
      t.match(output, /corbits\/config\.toml/);
      t.end();
    },
  );

  await t.test("initializes config and no-ops on repeated init", async (t) => {
    const configHome = withTempConfigHome(t);
    const initArgs = {
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: "table" as const,
      apiUrl: "https://api.corbits.dev",
    };

    const first = await captureStdout(() => configCommand.handler(initArgs));
    t.match(first, /config: initialized/);
    const written = await readConfigFile(configHome);
    t.match(written, /active_network = "solana-mainnet"/);

    const second = await captureStdout(() => configCommand.handler(initArgs));
    t.match(second, /already initialized/);
    t.end();
  });

  await t.test("prints resolved config summary", async (t) => {
    const configHome = withTempConfigHome(t);
    const config: CorbitsConfig = {
      version: 1,
      active_network: "base",
      preferences: {
        format: "json",
        api_url: "https://api.example.com",
      },
      networks: {
        base: {
          address: "0x1234",
          keyfile: "~/.config/corbits/keys/base.key",
        },
      },
    };
    await fs.mkdir(path.join(configHome, "corbits"), { recursive: true });
    await fs.writeFile(
      path.join(configHome, "corbits", "config.toml"),
      stringifyConfig(config),
    );

    const output = await captureStdout(() =>
      configCommand.handler({
        action: undefined,
        target: undefined,
        value: undefined,
        network: undefined,
        address: undefined,
        keyfile: undefined,
        format: undefined,
        apiUrl: undefined,
      }),
    );
    t.match(output, /active_network: base/);
    t.match(output, /expanded_keyfile/);
    t.end();
  });

  await t.test("switches active network", async (t) => {
    const configHome = withTempConfigHome(t);
    await configCommand.handler({
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: undefined,
      apiUrl: undefined,
    });
    await configCommand.handler({
      action: "network",
      target: "add",
      value: "base",
      network: undefined,
      address: "0x1234",
      keyfile: "~/.config/corbits/keys/base.key",
      format: undefined,
      apiUrl: undefined,
    });

    const output = await captureStdout(() =>
      configCommand.handler({
        action: "use",
        target: "base",
        value: undefined,
        network: undefined,
        address: undefined,
        keyfile: undefined,
        format: undefined,
        apiUrl: undefined,
      }),
    );
    t.match(output, /active_network: base/);
    const written = await readConfigFile(configHome);
    t.match(written, /active_network = "base"/);
    t.end();
  });

  await t.test("adds, updates, and removes non-active networks", async (t) => {
    const configHome = withTempConfigHome(t);
    await configCommand.handler({
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: undefined,
      apiUrl: undefined,
    });

    await configCommand.handler({
      action: "network",
      target: "add",
      value: "base",
      network: undefined,
      address: "0x1234",
      keyfile: "~/.config/corbits/keys/base.key",
      format: undefined,
      apiUrl: undefined,
    });

    await configCommand.handler({
      action: "network",
      target: "update",
      value: "base",
      network: undefined,
      address: "0x5678",
      keyfile: undefined,
      format: undefined,
      apiUrl: undefined,
    });

    let written = await readConfigFile(configHome);
    t.match(written, /address = "0x5678"/);

    await configCommand.handler({
      action: "network",
      target: "remove",
      value: "base",
      network: undefined,
      address: undefined,
      keyfile: undefined,
      format: undefined,
      apiUrl: undefined,
    });

    written = await readConfigFile(configHome);
    t.notMatch(written, /\[networks\.base\]/);
    t.end();
  });

  await t.test("rejects removing the active network", async (t) => {
    withTempConfigHome(t);
    await configCommand.handler({
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: undefined,
      apiUrl: undefined,
    });

    await t.rejects(
      configCommand.handler({
        action: "network",
        target: "remove",
        value: "solana-mainnet",
        network: undefined,
        address: undefined,
        keyfile: undefined,
        format: undefined,
        apiUrl: undefined,
      }),
      /Cannot remove active network/,
    );
    t.end();
  });

  await t.test("updates preferences", async (t) => {
    const configHome = withTempConfigHome(t);
    await configCommand.handler({
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: undefined,
      apiUrl: undefined,
    });

    await configCommand.handler({
      action: "format",
      target: "yaml",
      value: undefined,
      network: undefined,
      address: undefined,
      keyfile: undefined,
      format: undefined,
      apiUrl: undefined,
    });
    await configCommand.handler({
      action: "api-url",
      target: "https://staging.corbits.dev",
      value: undefined,
      network: undefined,
      address: undefined,
      keyfile: undefined,
      format: undefined,
      apiUrl: undefined,
    });

    const written = await readConfigFile(configHome);
    t.match(written, /format = "yaml"/);
    t.match(written, /api_url = "https:\/\/staging\.corbits\.dev"/);
    t.end();
  });

  await t.test("rejects blank network values before saving", async (t) => {
    const configHome = withTempConfigHome(t);
    await configCommand.handler({
      action: "init",
      target: undefined,
      value: undefined,
      network: "solana-mainnet",
      address: "7xKX...",
      keyfile: "~/.config/corbits/keys/solana.key",
      format: undefined,
      apiUrl: undefined,
    });

    await t.rejects(
      configCommand.handler({
        action: "network",
        target: "add",
        value: "base",
        network: undefined,
        address: "   ",
        keyfile: "~/.config/corbits/keys/base.key",
        format: undefined,
        apiUrl: undefined,
      }),
      /requires --address/,
    );

    const written = await readConfigFile(configHome);
    t.notMatch(written, /\[networks\.base\]/);
    t.end();
  });

  await t.test(
    "rejects invalid api url updates without corrupting config",
    async (t) => {
      const configHome = withTempConfigHome(t);
      await configCommand.handler({
        action: "init",
        target: undefined,
        value: undefined,
        network: "solana-mainnet",
        address: "7xKX...",
        keyfile: "~/.config/corbits/keys/solana.key",
        format: undefined,
        apiUrl: undefined,
      });

      await t.rejects(
        configCommand.handler({
          action: "api-url",
          target: "not-a-url",
          value: undefined,
          network: undefined,
          address: undefined,
          keyfile: undefined,
          format: undefined,
          apiUrl: undefined,
        }),
        /preferences\.api_url/,
      );

      const written = await readConfigFile(configHome);
      t.match(written, /api_url = "https:\/\/api\.corbits\.dev"/);
      t.end();
    },
  );
});
