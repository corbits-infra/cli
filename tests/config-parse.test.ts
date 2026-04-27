#!/usr/bin/env pnpm tsx

import os from "node:os";
import path from "node:path";
import t from "tap";
import {
  type CorbitsConfig,
  formatSupportedPaymentNetworks,
  getPaymentNetworkDefaults,
  getWalletFamilyForNetwork,
  isPaymentNetwork,
  listPaymentNetworks,
  parseConfig,
  resolveConfig,
  stringifyConfig,
} from "../src/config/schema.js";

const sample = `version = 1

[preferences]
format = "table"
api_url = "https://api.corbits.dev"

[payment]
network = "devnet"

[payment.rpc_url_overrides]
devnet = "https://rpc.devnet.example"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/devnet.json"
`;

await t.test("config parsing and resolution", async (t) => {
  await t.test("exposes canonical network metadata", async (t) => {
    t.same(listPaymentNetworks(), [
      "devnet",
      "mainnet-beta",
      "localnet",
      "base",
      "base-sepolia",
    ]);
    t.equal(
      formatSupportedPaymentNetworks(),
      "solana-devnet, solana-mainnet-beta, solana-localnet, base, base-sepolia",
    );
    t.equal(isPaymentNetwork("devnet"), true);
    t.equal(isPaymentNetwork("polygon-mainnet"), false);
    t.equal(getWalletFamilyForNetwork("base-sepolia"), "evm");
    t.same(getPaymentNetworkDefaults("mainnet-beta"), {
      asset: "USDC",
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
    t.end();
  });

  await t.test(
    "parses valid config and resolves payment from wallet plus network defaults",
    async (t) => {
      const parsed = parseConfig(sample);
      const resolved = resolveConfig(parsed);

      t.equal(parsed.payment.network, "devnet");
      t.equal(parsed.wallets.solana?.address, "7xKX...");
      t.equal(resolved.payment.family, "solana");
      t.same(resolved.activeWallet, {
        address: "7xKX...",
        family: "solana",
        kind: "keypair",
        path: "~/.config/corbits/keys/devnet.json",
        expandedPath: path.join(
          os.homedir(),
          ".config/corbits/keys/devnet.json",
        ),
      });
      t.same(resolved.payment, {
        network: "devnet",
        family: "solana",
        address: "7xKX...",
        asset: "USDC",
        rpcUrl: "https://rpc.devnet.example",
      });
      t.match(stringifyConfig(parsed), /\[payment\]\nnetwork = "devnet"/);
      t.end();
    },
  );

  await t.test(
    "supports both wallet families and EVM-active configs",
    async (t) => {
      const parsed = parseConfig(`version = 1

[preferences]
format = "json"
api_url = "https://api.corbits.dev"

[payment]
network = "base-sepolia"

[payment.rpc_url_overrides]
base-sepolia = "https://base-sepolia.example"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/solana.json"

[wallets.evm]
address = "0x1234"
kind = "ows"
wallet_id = "primary-evm"
`);

      t.equal(parsed.wallets.solana?.kind, "keypair");
      t.equal(parsed.wallets.evm?.kind, "ows");
      t.same(resolveConfig(parsed).activeWallet, {
        address: "0x1234",
        family: "evm",
        kind: "ows",
        walletId: "primary-evm",
      });
      t.same(resolveConfig(parsed).payment, {
        network: "base-sepolia",
        family: "evm",
        address: "0x1234",
        asset: "USDC",
        rpcUrl: "https://base-sepolia.example",
      });
      t.end();
    },
  );

  await t.test(
    "accepts CAIP-2 network identifiers and normalizes them to CLI names",
    async (t) => {
      const parsed = parseConfig(`version = 1

[preferences]
format = "json"
api_url = "https://api.corbits.dev"

[payment]
network = "eip155:84532"

[payment.rpc_url_overrides]
"eip155:84532" = "https://base-sepolia.example"

[wallets.evm]
address = "0x1234"
kind = "ows"
wallet_id = "primary-evm"
`);

      t.equal(parsed.payment.network, "base-sepolia");
      t.same(parsed.payment.rpc_url_overrides, {
        "base-sepolia": "https://base-sepolia.example",
      });
      t.equal(resolveConfig(parsed).payment.family, "evm");
      t.end();
    },
  );

  await t.test("normalizes field order deterministically", async (t) => {
    const config: CorbitsConfig = {
      version: 1,
      preferences: {
        format: "yaml",
        api_url: "https://api.corbits.dev",
      },
      payment: {
        network: "base",
        rpc_url_overrides: {
          base: "https://base.example",
        },
      },
      wallets: {
        evm: {
          address: "0x1234",
          kind: "ows",
          wallet_id: "primary-evm",
        },
        solana: {
          address: "7xKX...",
          kind: "keypair",
          path: "~/.config/corbits/keys/solana.json",
        },
      },
    };

    const serialized = stringifyConfig(config);
    t.match(
      serialized,
      /version = 1[\s\S]*\[preferences\][\s\S]*\[payment\][\s\S]*\[wallets\.solana\][\s\S]*\[wallets\.evm\]/,
    );
    t.equal(parseConfig(serialized).payment.network, "base");
    t.end();
  });

  await t.test("rejects invalid config shapes", async (t) => {
    t.throws(
      () =>
        parseConfig(`version = 1
active_network = "mainnet-beta"

[preferences]
format = "table"
api_url = "https://api.corbits.dev"

[payment]
network = "devnet"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/devnet.json"
`),
      /Unknown config key "active_network"/,
    );

    t.throws(
      () => parseConfig(sample.replace('"devnet"', '"polygon-mainnet"')),
      new RegExp(formatSupportedPaymentNetworks()),
    );

    t.throws(
      () =>
        parseConfig(`version = 1

[preferences]
format = "table"
api_url = "https://api.corbits.dev"

[payment]
network = "base"

[wallets.solana]
address = "7xKX..."
kind = "keypair"
path = "~/.config/corbits/keys/devnet.json"
`),
      /wallets\.evm is required/,
    );

    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'path = "~/.config/corbits/keys/devnet.json"',
            'path = "~/.config/corbits/keys/devnet.json"\nwallet_id = "nope"',
          ),
        ),
      /wallet_id is not allowed when kind is "keypair"/,
    );

    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'kind = "keypair"\npath = "~/.config/corbits/keys/devnet.json"',
            'kind = "ows"\npath = "~/.config/corbits/keys/devnet.json"',
          ),
        ),
      /path must be removed/,
    );

    t.throws(
      () => parseConfig(sample.replace('address = "7xKX..."', 'address = ""')),
      /address must be non-empty/,
    );

    t.throws(
      () =>
        parseConfig(
          sample.replace(
            '[payment]\nnetwork = "devnet"',
            '[payment]\nnetwork = "devnet"\nrpc_url = "https://api.devnet.solana.com"',
          ),
        ),
      /Unknown payment key "rpc_url"/,
    );

    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'devnet = "https://rpc.devnet.example"',
            'polygon-mainnet = "https://polygon.example"',
          ),
        ),
      /rpc_url_overrides key "polygon-mainnet"/,
    );

    t.throws(
      () =>
        parseConfig(
          sample.replace(
            'devnet = "https://rpc.devnet.example"',
            'devnet = "not-a-url"',
          ),
        ),
      /payment\.rpc_url_overrides\.devnet/,
    );

    t.throws(
      () =>
        parseConfig(
          `${sample}
[wallets.evm]
address = "0x1234"
kind = "ows"
wallet_id = "primary-evm"
extra = "nope"
`,
        ),
      /Unknown wallets\.evm key "extra"/,
    );

    t.throws(() => parseConfig("[preferences"), /Invalid config TOML/);
    t.end();
  });
});
