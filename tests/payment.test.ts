#!/usr/bin/env pnpm tsx

import t from "tap";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createBuildPayer } from "../src/payment/payer.js";
import { createBuildOwsAdapter } from "../src/payment/ows.js";

await t.test("payer helpers", async (t) => {
  await t.test("rejects unsupported payer networks", async (t) => {
    const buildPayer = createBuildPayer({
      createPayer: (() => {
        throw new Error("should not create payer for unsupported networks");
      }) as never,
      buildOwsAdapter: (async () => {
        throw new Error(
          "should not build OWS adapter for unsupported networks",
        );
      }) as never,
    });

    await t.rejects(
      () =>
        buildPayer({
          version: 1,
          preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
          payment: {
            network: "localnet",
            family: "solana",
            address: "So11111111111111111111111111111111111111112",
            asset: "USDC",
            rpcUrl: "http://127.0.0.1:8899",
          },
          activeWallet: {
            kind: "keypair",
            family: "solana",
            address: "So11111111111111111111111111111111111111112",
            path: "~/.config/solana/id.json",
            expandedPath: "/tmp/id.json",
          },
        }),
      /does not support network localnet/,
    );
  });

  await t.test("buildPayer uses expanded keypair path", async (t) => {
    const seen: { networks: string[] | undefined; wallet: string | undefined } =
      {
        networks: undefined,
        wallet: undefined,
      };
    const buildPayer = createBuildPayer({
      createPayer: ((args?: { networks?: string[] }) => ({
        addWalletAdapter: () => undefined,
        addLocalWallet: async (wallet: string) => {
          seen.networks = args?.networks;
          seen.wallet = wallet;
        },
        fetch: async () => new Response(),
      })) as never,
      buildOwsAdapter: (async () => {
        throw new Error("should not build OWS adapter for keypair wallets");
      }) as never,
    });

    await buildPayer({
      version: 1,
      preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
      payment: {
        network: "devnet",
        family: "solana",
        address: "So11111111111111111111111111111111111111112",
        asset: "USDC",
        rpcUrl: "https://api.devnet.solana.com",
      },
      activeWallet: {
        kind: "keypair",
        family: "solana",
        address: "So11111111111111111111111111111111111111112",
        path: "~/.config/solana/id.json",
        expandedPath: "/tmp/id.json",
      },
    });

    t.same(seen.networks, ["solana-devnet"]);
    t.equal(seen.wallet, "/tmp/id.json");
  });

  await t.test("buildPayer registers OWS adapters", async (t) => {
    let adapterAdded = false;
    const owsAdapter = {
      x402Id: [],
      paymentHandler: async () => [],
      getBalance: async () => ({ name: "USDC", amount: 0n, decimals: 6 }),
    };

    const buildPayer = createBuildPayer({
      createPayer: (() => ({
        addWalletAdapter: (adapter: unknown) => {
          adapterAdded = adapter === owsAdapter;
        },
        addLocalWallet: async () => undefined,
        fetch: async () => new Response(),
      })) as never,
      buildOwsAdapter: (async () => owsAdapter) as never,
    });

    await buildPayer({
      version: 1,
      preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
      payment: {
        network: "base",
        family: "evm",
        address: "0x1234",
        asset: "USDC",
        rpcUrl: "https://mainnet.base.org",
      },
      activeWallet: {
        kind: "ows",
        family: "evm",
        address: "0x1234",
        walletId: "primary",
      },
    });

    t.equal(adapterAdded, true);
  });
});

await t.test("OWS adapter", async (t) => {
  await t.test(
    "builds Solana adapters without passphrase handling",
    async (t) => {
      let signTransactionArgs: unknown[] | undefined;
      let capturedWallet:
        | {
            publicKey: PublicKey;
            partiallySignTransaction(
              tx: VersionedTransaction,
            ): Promise<VersionedTransaction>;
          }
        | undefined;
      let parsedTokenAccountsByOwnerArgs: unknown[] | undefined;

      const buildOwsAdapter = createBuildOwsAdapter({
        getWallet: (() => ({
          id: "wallet-solana-id",
          name: "primary-solana",
          accounts: [
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "So11111111111111111111111111111111111111112",
              derivationPath: "m/44'/501'/0'/0'",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: ((...args: unknown[]) => {
          signTransactionArgs = args;
          t.equal(args.length, 3);
          return { signature: "11".repeat(64) };
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign typed data for Solana");
        }) as never,
        createConnection: (() =>
          ({
            getTokenAccountBalance: async (...args: unknown[]) => {
              parsedTokenAccountsByOwnerArgs = args;
              return {
                value: {
                  amount: "42",
                  decimals: 6,
                },
              };
            },
          }) as never) as never,
        createPublicClient: (() => ({}) as never) as never,
        lookupKnownSPLToken: (() => ({
          address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          name: "USDC",
        })) as never,
        clusterToCAIP2: (() => ({
          caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: ((wallet: unknown) => {
          capturedWallet = wallet as typeof capturedWallet;
          return (async () => []) as never;
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error("should not create an EVM handler for Solana");
        }) as never,
        getErc20Balance: (async () => ({ amount: 0n, decimals: 6 })) as never,
      });

      const adapter = await buildOwsAdapter({
        version: 1,
        preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
        payment: {
          network: "devnet",
          family: "solana",
          address: "So11111111111111111111111111111111111111112",
          asset: "USDC",
          rpcUrl: "https://api.devnet.solana.com",
        },
        activeWallet: {
          kind: "ows",
          family: "solana",
          address: "So11111111111111111111111111111111111111112",
          walletId: "primary-solana",
        },
      });

      t.same(adapter.x402Id, [
        {
          scheme: "exact",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        },
      ]);

      if (capturedWallet == null) {
        throw new Error("expected Solana wallet to be captured");
      }

      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: capturedWallet.publicKey,
          recentBlockhash: "11111111111111111111111111111111",
          instructions: [],
        }).compileToV0Message(),
      );
      const unsignedTxHex = Buffer.from(tx.serialize()).toString("hex");
      await capturedWallet.partiallySignTransaction(tx);
      t.same(signTransactionArgs, [
        "wallet-solana-id",
        "solana",
        unsignedTxHex,
      ]);
      const signature = tx.signatures[0];
      t.equal(signature?.length, 64);
      if (signature == null) {
        throw new Error("expected Solana signature to be attached");
      }
      t.same([...signature], new Array(64).fill(0x11));

      const balance = await adapter.getBalance();
      t.same(balance, { name: "USDC", amount: 42n, decimals: 6 });
      t.equal(parsedTokenAccountsByOwnerArgs?.length, 2);
      t.equal(
        (
          parsedTokenAccountsByOwnerArgs?.[0] as PublicKey | undefined
        )?.toBase58(),
        getAssociatedTokenAddressSync(
          new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
          new PublicKey("So11111111111111111111111111111111111111112"),
        ).toBase58(),
      );
      t.equal(parsedTokenAccountsByOwnerArgs?.[1], "confirmed");
    },
  );

  await t.test("builds EVM adapters without passphrase handling", async (t) => {
    let capturedWallet:
      | {
          account: {
            signTypedData(params: unknown): Promise<string>;
          };
        }
      | undefined;
    let signTypedDataArgs: unknown[] | undefined;

    const buildOwsAdapter = createBuildOwsAdapter({
      getWallet: (() => ({
        id: "wallet-evm-id",
        name: "primary-evm",
        accounts: [
          {
            chainId: "eip155:8453",
            address: "0x1234000000000000000000000000000000000000",
            derivationPath: "m/44'/60'/0'/0/0",
          },
        ],
        createdAt: "",
      })) as never,
      signTransaction: (() => {
        throw new Error("should not sign Solana transactions for EVM");
      }) as never,
      signTypedData: ((...args: unknown[]) => {
        signTypedDataArgs = args;
        return { signature: "abc123" };
      }) as never,
      createConnection: (() => ({}) as never) as never,
      createPublicClient: ((config: unknown) => config) as never,
      lookupKnownSPLToken: (() => undefined) as never,
      clusterToCAIP2: (() => ({ caip2: "" })) as never,
      lookupKnownAsset: (() => ({
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        contractName: "USD Coin",
      })) as never,
      lookupX402Network: (() => "eip155:8453") as never,
      createSolanaPaymentHandler: (() => {
        throw new Error("should not create a Solana handler for EVM");
      }) as never,
      createEvmPaymentHandler: ((wallet: unknown) => {
        capturedWallet = wallet as typeof capturedWallet;
        return (async () => []) as never;
      }) as never,
      getErc20Balance: (async () => ({ amount: 7n, decimals: 6 })) as never,
    });

    const adapter = await buildOwsAdapter({
      version: 1,
      preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
      payment: {
        network: "base",
        family: "evm",
        address: "0x1234000000000000000000000000000000000000",
        asset: "USDC",
        rpcUrl: "https://mainnet.base.org",
      },
      activeWallet: {
        kind: "ows",
        family: "evm",
        address: "0x1234000000000000000000000000000000000000",
        walletId: "primary-evm",
      },
    });

    t.same(adapter.x402Id, [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
    ]);

    if (capturedWallet == null) {
      throw new Error("expected EVM wallet to be captured");
    }

    const signature = await capturedWallet.account.signTypedData({
      domain: { chainId: 8453 },
      types: {},
      primaryType: "TransferWithAuthorization",
      message: { value: 1n },
    });

    t.equal(signature, "0xabc123");
    t.equal(signTypedDataArgs?.length, 3);
    t.equal(signTypedDataArgs?.[0], "wallet-evm-id");
    t.equal(signTypedDataArgs?.[1], "base");
    t.match(String(signTypedDataArgs?.[2]), /EIP712Domain/);
    t.match(String(signTypedDataArgs?.[2]), /"value":"1"/);
    t.same(await adapter.getBalance(), {
      amount: 7n,
      decimals: 6,
      name: "USD Coin",
    });
  });

  await t.test(
    "rejects Solana OWS wallets with a mismatched address",
    async (t) => {
      const buildOwsAdapter = createBuildOwsAdapter({
        getWallet: (() => ({
          id: "wallet-solana-id",
          name: "primary-solana",
          accounts: [
            {
              chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              address: "8GUFsPwiE7npjTXujUua5yEuEm1cPefB8MpWkLJ1Fvr6",
              derivationPath: "m/44'/501'/0'/0'",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign for mismatched Solana wallets");
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign typed data for Solana");
        }) as never,
        createConnection: (() => ({}) as never) as never,
        createPublicClient: (() => ({}) as never) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: (() => {
          throw new Error(
            "should not create a Solana handler for mismatched wallets",
          );
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error("should not create an EVM handler for Solana");
        }) as never,
        getErc20Balance: (async () => ({ amount: 0n, decimals: 6 })) as never,
      });

      await t.rejects(
        () =>
          buildOwsAdapter({
            version: 1,
            preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
            payment: {
              network: "devnet",
              family: "solana",
              address: "So11111111111111111111111111111111111111112",
              asset: "USDC",
              rpcUrl: "https://api.devnet.solana.com",
            },
            activeWallet: {
              kind: "ows",
              family: "solana",
              address: "So11111111111111111111111111111111111111112",
              walletId: "primary-solana",
            },
          }),
        /does not match OWS wallet/,
      );
    },
  );

  await t.test(
    "rejects EVM OWS wallets with a mismatched address",
    async (t) => {
      const buildOwsAdapter = createBuildOwsAdapter({
        getWallet: (() => ({
          id: "wallet-evm-id",
          name: "primary-evm",
          accounts: [
            {
              chainId: "eip155:8453",
              address: "0x9999000000000000000000000000000000000000",
              derivationPath: "m/44'/60'/0'/0/0",
            },
          ],
          createdAt: "",
        })) as never,
        signTransaction: (() => {
          throw new Error("should not sign Solana transactions for EVM");
        }) as never,
        signTypedData: (() => {
          throw new Error("should not sign for mismatched EVM wallets");
        }) as never,
        createConnection: (() => ({}) as never) as never,
        createPublicClient: (() => ({}) as never) as never,
        lookupKnownSPLToken: (() => undefined) as never,
        clusterToCAIP2: (() => ({ caip2: "" })) as never,
        lookupKnownAsset: (() => undefined) as never,
        lookupX402Network: (() => "") as never,
        createSolanaPaymentHandler: (() => {
          throw new Error("should not create a Solana handler for EVM");
        }) as never,
        createEvmPaymentHandler: (() => {
          throw new Error(
            "should not create an EVM handler for mismatched wallets",
          );
        }) as never,
        getErc20Balance: (async () => ({ amount: 0n, decimals: 6 })) as never,
      });

      await t.rejects(
        () =>
          buildOwsAdapter({
            version: 1,
            preferences: { format: "table", apiUrl: "https://api.corbits.dev" },
            payment: {
              network: "base",
              family: "evm",
              address: "0x1234000000000000000000000000000000000000",
              asset: "USDC",
              rpcUrl: "https://mainnet.base.org",
            },
            activeWallet: {
              kind: "ows",
              family: "evm",
              address: "0x1234000000000000000000000000000000000000",
              walletId: "primary-evm",
            },
          }),
        /does not match OWS wallet/,
      );
    },
  );
});
