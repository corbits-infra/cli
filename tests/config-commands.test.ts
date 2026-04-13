#!/usr/bin/env pnpm tsx

import t from "tap";
import * as configCommands from "../src/commands/config.js";
import { configInit, configSet, configShow } from "../src/commands/config.js";
import { getConfigPath } from "../src/config/index.js";
import {
  captureStdout,
  readTempConfigFile,
  withTempConfigHome,
} from "./helpers.js";

async function seedConfig(options?: {
  includeEvmWallet?: boolean;
}): Promise<void> {
  await configInit.handler({
    network: "mainnet-beta",
    rpcUrl: undefined,
    solanaAddress: "7xKX...",
    solanaPath: "~/.config/corbits/keys/solana.json",
    solanaOws: undefined,
    evmAddress: options?.includeEvmWallet === false ? undefined : "0x1234",
    evmPath: undefined,
    evmOws: options?.includeEvmWallet === false ? undefined : "primary-evm",
    format: "table",
    apiUrl: "https://api.corbits.dev",
    config: undefined,
  });
}

await t.test("config commands", async (t) => {
  await t.test("exports only the simplified command surface", async (t) => {
    t.equal("configUse" in configCommands, false);
    t.equal("configAccount" in configCommands, false);
    t.equal("configAccountSet" in configCommands, false);
    t.equal("configAccountRemove" in configCommands, false);
    t.equal("configSetNetwork" in configCommands, false);
    t.equal("configSetAddress" in configCommands, false);
    t.equal("configSetAsset" in configCommands, false);
    t.equal("configSetRpcUrl" in configCommands, false);
    t.equal("configSetWallet" in configCommands, false);
    t.equal("configSetFormat" in configCommands, false);
    t.equal("configSetApiUrl" in configCommands, false);
    t.end();
  });

  await t.test("init success paths", async (t) => {
    await t.test("initializes a Solana payment config", async (t) => {
      const configHome = withTempConfigHome(t);

      const output = await captureStdout(() =>
        configInit.handler({
          network: "mainnet-beta",
          rpcUrl: undefined,
          solanaAddress: "7xKX...",
          solanaPath: "~/.config/corbits/keys/solana.json",
          solanaOws: undefined,
          evmAddress: undefined,
          evmPath: undefined,
          evmOws: undefined,
          format: "table",
          apiUrl: "https://api.corbits.dev",
          config: undefined,
        }),
      );

      t.match(output, /config: initialized/);
      t.match(output, /payment_network/);
      t.match(output, /payment_address/);
      t.match(output, /7xKX\.\.\./);

      const written = await readTempConfigFile(configHome);
      t.match(written, /\[payment\]/);
      t.match(written, /network = "mainnet-beta"/);
      t.notMatch(written, /asset =/);
      t.notMatch(written, /rpc_url =/);
      t.match(written, /\[wallets\.solana\]/);
      t.match(written, /address = "7xKX\.\.\."/);
      t.match(written, /path = "~\/\.config\/corbits\/keys\/solana\.json"/);
      t.end();
    });

    await t.test("initializes an EVM payment config", async (t) => {
      const configHome = withTempConfigHome(t);

      await configInit.handler({
        network: "base-sepolia",
        rpcUrl: "https://base-sepolia.example",
        solanaAddress: undefined,
        solanaPath: undefined,
        solanaOws: undefined,
        evmAddress: "0x1234",
        evmPath: undefined,
        evmOws: "primary-evm",
        format: undefined,
        apiUrl: undefined,
        config: undefined,
      });

      const written = await readTempConfigFile(configHome);
      t.match(written, /network = "base-sepolia"/);
      t.match(written, /\[payment\.rpc_url_overrides\]/);
      t.match(written, /base-sepolia = "https:\/\/base-sepolia\.example"/);
      t.match(written, /\[wallets\.evm\]/);
      t.match(written, /address = "0x1234"/);
      t.match(written, /wallet_id = "primary-evm"/);
      t.end();
    });

    await t.test("returns a no-op when config already exists", async (t) => {
      withTempConfigHome(t);
      await seedConfig();

      const output = await captureStdout(() =>
        configInit.handler({
          network: "devnet",
          rpcUrl: undefined,
          solanaAddress: "8yZZ...",
          solanaPath: "~/.config/corbits/keys/devnet.json",
          solanaOws: undefined,
          evmAddress: undefined,
          evmPath: undefined,
          evmOws: undefined,
          format: undefined,
          apiUrl: undefined,
          config: undefined,
        }),
      );

      t.match(output, /already initialized/);
      t.match(output, /payment_network/);
      t.match(output, /mainnet-beta/);
      t.end();
    });

    await t.test("rejects conflicting wallet source flags", async (t) => {
      withTempConfigHome(t);

      await t.rejects(
        () =>
          configInit.handler({
            network: "mainnet-beta",
            rpcUrl: undefined,
            solanaAddress: "7xKX...",
            solanaPath: "~/.config/corbits/keys/solana.json",
            solanaOws: "primary-solana",
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        /only one of --solana-path or --solana-ows/,
      );
      t.end();
    });

    await t.test(
      "rejects missing wallet address for the provided wallet source",
      async (t) => {
        withTempConfigHome(t);

        await t.rejects(
          () =>
            configInit.handler({
              network: "mainnet-beta",
              rpcUrl: undefined,
              solanaAddress: undefined,
              solanaPath: "~/.config/corbits/keys/solana.json",
              solanaOws: undefined,
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /requires --solana-address/,
        );
        t.end();
      },
    );

    await t.test(
      "rejects init without the wallet flags required by the selected Solana network",
      async (t) => {
        withTempConfigHome(t);

        await t.rejects(
          () =>
            configInit.handler({
              network: "devnet",
              rpcUrl: undefined,
              solanaAddress: undefined,
              solanaPath: undefined,
              solanaOws: undefined,
              evmAddress: "0x1234",
              evmPath: undefined,
              evmOws: "primary-evm",
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /requires --solana-address <addr> plus one of --solana-path <path> or --solana-ows <wallet-id> when --network devnet is selected/,
        );
        t.end();
      },
    );

    await t.test(
      "rejects init without the wallet flags required by the selected EVM network",
      async (t) => {
        withTempConfigHome(t);

        await t.rejects(
          () =>
            configInit.handler({
              network: "base-sepolia",
              rpcUrl: undefined,
              solanaAddress: "7xKX...",
              solanaPath: "~/.config/corbits/keys/solana.json",
              solanaOws: undefined,
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /requires --evm-address <addr> plus one of --evm-path <path> or --evm-ows <wallet-id> when --network base-sepolia is selected/,
        );
        t.end();
      },
    );
  });

  await t.test("set success paths", async (t) => {
    await t.test(
      "switches network using the wallet for that family",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig();

        const output = await captureStdout(() =>
          configSet.handler({
            network: "base",
            rpcUrl: undefined,
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        );

        t.match(output, /payment_network/);
        t.match(output, /payment_address/);
        t.match(output, /payment_rpc_url/);
        t.match(output, /0x1234/);
        t.match(output, /https:\/\/mainnet\.base\.org/);

        const written = await readTempConfigFile(configHome);
        t.match(written, /network = "base"/);
        t.notMatch(written, /payment_address/);
        t.notMatch(written, /rpc_url =/);
        t.end();
      },
    );

    await t.test(
      "stores rpc override for the target network only",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig();

        await captureStdout(() =>
          configSet.handler({
            network: undefined,
            rpcUrl: "https://mainnet-beta.example",
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        );

        await captureStdout(() =>
          configSet.handler({
            network: "base",
            rpcUrl: "https://base.example",
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        );

        const written = await readTempConfigFile(configHome);
        t.match(written, /\[payment\.rpc_url_overrides\]/);
        t.match(
          written,
          /mainnet-beta = "https:\/\/mainnet-beta\.example"/,
        );
        t.match(written, /base = "https:\/\/base\.example"/);

        const output = await captureStdout(() =>
          configShow.handler({ format: "json", config: undefined }),
        );
        const parsed = JSON.parse(output) as {
          payment: {
            network: string;
            family: string;
            address: string;
            asset: string;
            rpc_url: string;
            rpc_url_override?: string;
          };
        };
        t.same(parsed.payment, {
          network: "base",
          family: "evm",
          address: "0x1234",
          asset: "USDC",
          rpc_url: "https://base.example",
          rpc_url_override: "https://base.example",
        });
        t.end();
      },
    );

    await t.test(
      "updates wallet sources and addresses without stale fields",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig();

        await captureStdout(() =>
          configSet.handler({
            network: undefined,
            rpcUrl: undefined,
            solanaAddress: "So1111...",
            solanaPath: undefined,
            solanaOws: "primary-solana",
            evmAddress: "0x5678",
            evmPath: "~/.config/corbits/keys/base.key",
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        );

        const written = await readTempConfigFile(configHome);
        const solanaSection = /\[wallets\.solana\]\n([\s\S]*?)(?:\n\[|$)/.exec(
          written,
        )?.[1];
        const evmSection = /\[wallets\.evm\]\n([\s\S]*?)(?:\n\[|$)/.exec(
          written,
        )?.[1];

        t.match(
          solanaSection ?? "",
          /address = "So1111\.\.\."\nkind = "ows"\nwallet_id = "primary-solana"/,
        );
        t.notMatch(solanaSection ?? "", /path =/);
        t.match(
          evmSection ?? "",
          /address = "0x5678"\nkind = "keypair"\npath = "~\/\.config\/corbits\/keys\/base\.key"/,
        );
        t.notMatch(evmSection ?? "", /wallet_id = "primary-evm"/);
        t.end();
      },
    );

    await t.test(
      "updates preferences and renders yaml when format is yaml",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig();

        const output = await captureStdout(() =>
          configSet.handler({
            network: undefined,
            rpcUrl: undefined,
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: "yaml",
            apiUrl: "https://staging.corbits.dev",
            config: undefined,
          }),
        );

        t.match(output, /^status: ok/m);
        t.match(output, /^format: yaml/m);
        t.match(output, /^api_url: https:\/\/staging\.corbits\.dev/m);

        const written = await readTempConfigFile(configHome);
        t.match(written, /format = "yaml"/);
        t.match(written, /api_url = "https:\/\/staging\.corbits\.dev"/);
        t.end();
      },
    );

    await t.test(
      "updates preferences and uses NO_DNA for mutation output",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig();
        process.env.NO_DNA = "1";

        const output = await captureStdout(() =>
          configSet.handler({
            network: "base",
            rpcUrl: undefined,
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: "yaml",
            apiUrl: "https://staging.corbits.dev",
            config: undefined,
          }),
        );

        t.same(JSON.parse(output), {
          status: "ok",
          action: "set",
          payment_network: "base",
          format: "yaml",
          api_url: "https://staging.corbits.dev",
          payment_address: "0x1234",
          payment_asset: "USDC",
          payment_rpc_url: "https://mainnet.base.org",
        });

        const written = await readTempConfigFile(configHome);
        t.match(written, /format = "yaml"/);
        t.match(written, /api_url = "https:\/\/staging\.corbits\.dev"/);
        t.end();
      },
    );
  });

  await t.test("set failure paths", async (t) => {
    await t.test("rejects empty config set invocations", async (t) => {
      withTempConfigHome(t);
      await seedConfig();

      await t.rejects(
        () =>
          configSet.handler({
            network: undefined,
            rpcUrl: undefined,
            solanaAddress: undefined,
            solanaPath: undefined,
            solanaOws: undefined,
            evmAddress: undefined,
            evmPath: undefined,
            evmOws: undefined,
            format: undefined,
            apiUrl: undefined,
            config: undefined,
          }),
        /at least one flag/,
      );
      t.end();
    });

    await t.test(
      "rejects invalid mutations without corrupting config",
      async (t) => {
        const configHome = withTempConfigHome(t);
        await seedConfig({ includeEvmWallet: false });
        const before = await readTempConfigFile(configHome);

        await t.rejects(
          () =>
            configSet.handler({
              network: "polygon-mainnet",
              rpcUrl: undefined,
              solanaAddress: undefined,
              solanaPath: undefined,
              solanaOws: undefined,
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /Invalid payment network/,
        );

        await t.rejects(
          () =>
            configSet.handler({
              network: "base",
              rpcUrl: undefined,
              solanaAddress: undefined,
              solanaPath: undefined,
              solanaOws: undefined,
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /wallets\.evm is required/,
        );

        await t.rejects(
          () =>
            configSet.handler({
              network: undefined,
              rpcUrl: undefined,
              solanaAddress: undefined,
              solanaPath: undefined,
              solanaOws: undefined,
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: "not-a-url",
              config: undefined,
            }),
          /preferences\.api_url/,
        );

        await t.rejects(
          () =>
            configSet.handler({
              network: undefined,
              rpcUrl: undefined,
              solanaAddress: "7xKX...",
              solanaPath: "~/.config/corbits/keys/solana.json",
              solanaOws: "primary-solana",
              evmAddress: undefined,
              evmPath: undefined,
              evmOws: undefined,
              format: undefined,
              apiUrl: undefined,
              config: undefined,
            }),
          /only one of --solana-path or --solana-ows/,
        );

        const after = await readTempConfigFile(configHome);
        t.equal(after, before);
        t.end();
      },
    );
  });

  await t.test("show command", async (t) => {
    await t.test(
      "renders missing-config help when config is absent",
      async (t) => {
        withTempConfigHome(t);

        const output = await captureStdout(() =>
          configShow.handler({ format: undefined, config: undefined }),
        );

        t.match(output, /config: not initialized/);
        t.match(output, /--network <name>/);
        t.match(output, /--solana-address <addr>/);
        t.match(output, /rpc-url <url>/);
        t.end();
      },
    );

    await t.test(
      "renders table and json views through the command layer",
      async (t) => {
        withTempConfigHome(t);
        await seedConfig();

        const textOutput = await captureStdout(() =>
          configShow.handler({ format: undefined, config: undefined }),
        );
        t.match(textOutput, /Payment network: mainnet-beta/);
        t.match(textOutput, /Payment address: 7xKX\.\.\./);
        t.match(
          textOutput,
          /Payment RPC URL: https:\/\/api\.mainnet-beta\.solana\.com/,
        );
        t.match(textOutput, /Wallet Family/);

        const jsonOutput = await captureStdout(() =>
          configShow.handler({ format: "json", config: undefined }),
        );
        const parsed = JSON.parse(jsonOutput) as {
          payment: { network: string; address: string; rpc_url: string };
          active_wallet: { expanded_path?: string; address: string };
          path: string;
        };
        t.equal(parsed.payment.network, "mainnet-beta");
        t.equal(parsed.payment.address, "7xKX...");
        t.equal(parsed.payment.rpc_url, "https://api.mainnet-beta.solana.com");
        t.equal(parsed.path, getConfigPath());
        t.equal(parsed.active_wallet.address, "7xKX...");
        t.match(
          parsed.active_wallet.expanded_path ?? "",
          /\/\.config\/corbits\/keys\/solana\.json$/,
        );
        t.end();
      },
    );
  });
});
