#!/usr/bin/env pnpm tsx

import fs from "node:fs/promises";
import path from "node:path";
import t from "tap";
import { type CorbitsConfig } from "../src/config/schema.js";
import { loadConfig, saveConfig } from "../src/config/store.js";
import { withTempConfigHome } from "./helpers.js";

await t.test("config storage", async (t) => {
  await t.test("saves atomically with canonical serialization", async (t) => {
    const configHome = withTempConfigHome(t);
    const configPath = path.join(configHome, "corbits", "config.toml");

    const config: CorbitsConfig = {
      version: 1,
      preferences: {
        format: "yaml",
        api_url: "https://api.corbits.dev",
      },
      payment: {
        network: "base-mainnet",
        rpc_url_overrides: {
          "base-mainnet": "https://base-mainnet.example",
        },
      },
      wallets: {
        evm: {
          address: "0x1234",
          wallet_id: "primary-evm",
          kind: "ows",
        },
        solana: {
          address: "7xKX...",
          path: "~/.config/corbits/keys/solana.json",
          kind: "keypair",
        },
      },
    };

    await saveConfig(configPath, config);

    const written = await fs.readFile(configPath, "utf8");
    t.match(
      written,
      /version = 1[\s\S]*\[preferences\][\s\S]*\[payment\]\nnetwork = "base-mainnet"[\s\S]*\[payment\.rpc_url_overrides\]\nbase-mainnet = "https:\/\/base-mainnet\.example"[\s\S]*\[wallets\.solana\]\naddress = "7xKX\.\.\."\nkind = "keypair"\npath = "~\/\.config\/corbits\/keys\/solana\.json"[\s\S]*\[wallets\.evm\]\naddress = "0x1234"\nkind = "ows"\nwallet_id = "primary-evm"/,
    );

    const loaded = await loadConfig();
    t.equal(loaded?.resolved.payment.network, "base-mainnet");
    t.same(loaded?.resolved.activeWallet, {
      address: "0x1234",
      family: "evm",
      kind: "ows",
      walletId: "primary-evm",
    });
    t.equal(loaded?.resolved.payment.rpcUrl, "https://base-mainnet.example");
    t.end();
  });
});
