# Corbits CLI

![Corbits CLI ASCII banner](assets/corbits-ascii.svg)

[Install](#install) · [Quick Start](#quick-start) ·
[Common Workflows](#common-workflows) · [Flex](#flex-prepaid-sessions) ·
[Command Reference](#command-reference) · [Development](#development)

Command-line client for discovering x402-gated APIs, inspecting payment
requirements, and paying with `curl` or `wget`.

Corbits talks to the discovery API at `https://api.corbits.dev`. Prices are
displayed in USDC.

## Install

Install globally when you want the `corbits` command on your path:

```bash
npm install -g @corbits/cli
corbits --help
```

Or run it without installing:

```bash
npx @corbits/cli discover
npx @corbits/cli inspect 73
```

The examples below use `corbits`. If you prefer `npx`, replace `corbits` with
`npx @corbits/cli`.

## Quick Start

Make a paid request and review the local history entry.

The examples use the Solana CLI default keypair and a live x402 endpoint from
CoinGecko. Use your own wallet and inspect the payment challenge before paying.

```bash
# 1. Configure a wallet and payment network
corbits config init \
  --network mainnet-beta \
  --solana-address "$(solana address)" \
  --solana-path ~/.config/solana/id.json \
  --rpc-url https://api.mainnet-beta.solana.com

# 2. Confirm what Corbits will use for payments
corbits config show
corbits balance

# 3. Find services and inspect catalog metadata before paying
corbits discover
corbits discover <search-term>
corbits inspect PROXY_ID

# 4. Probe a live x402 challenge without paying
ENDPOINT_URL="https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=solana&vs_currencies=usd"
corbits call --inspect curl "$ENDPOINT_URL"

# 5. Call it when you are ready
corbits call curl "$ENDPOINT_URL"

# 6. Review local paid-call history
corbits history
corbits history show HISTORY_INDEX
```

## What Happened

1. `discover` found APIs published through the Corbits discovery API.
2. `inspect` showed endpoint metadata, pricing, and OpenAPI details for a
   selected proxy.
3. `call --inspect` parses the live x402 challenge without paying when the
   endpoint returns `402 Payment Required`.
4. `call` signs a payment with the configured wallet and retries the request.
5. `history` shows local paid-call metadata. Use the table's `#` value with
   `history show` to inspect one entry.

## Common Workflows

Start here when you already know what you want to do.

| Workflow                          | Command to start with                   |
| --------------------------------- | --------------------------------------- |
| Find a paid API                   | `corbits discover`                      |
| Inspect pricing before paying     | `corbits inspect <proxy-id>`            |
| Configure a payment wallet        | `corbits config init`                   |
| Check funds                       | `corbits balance`                       |
| Probe a live challenge            | `corbits call --inspect curl`           |
| Make a paid request               | `corbits call curl`                     |
| Manage Flex sessions              | `corbits flex status`                   |
| Review paid-call history          | `corbits history`                       |
| Choose output formats             | `--format json` or `NO_DNA=1`           |
| See every command in compact form | [Command Reference](#command-reference) |

### Find APIs

```bash
corbits discover
corbits discover brave
corbits discover --tag dex
corbits discover --format json
```

Search results include matching proxies and endpoints. Use the proxy ID with
`inspect`.

### Inspect Pricing and OpenAPI

```bash
corbits inspect 73
corbits inspect 73 --openapi
corbits inspect 73 --format json
NO_DNA=1 corbits inspect 73
```

`inspect` shows proxy metadata, endpoints, schemes, and prices. `--openapi`
prints the upstream OpenAPI spec as YAML by default, or JSON with `--format json`.

### Configure Wallets

```bash
# Local Solana keypair
corbits config init \
  --network mainnet-beta \
  --solana-address "$(solana address)" \
  --solana-path ~/.config/solana/id.json

# Solana OWS wallet
corbits config init \
  --network devnet \
  --solana-address "$(solana address)" \
  --solana-ows primary-solana

# EVM keypair or OWS wallet
corbits config set --network base --evm-address 0x742d35Cc6634C0532925a3b844Bc454e4438f44e --evm-path ~/.config/corbits/keys/base.key
corbits config set --evm-address 0x742d35Cc6634C0532925a3b844Bc454e4438f44e --evm-ows primary-evm

# Spending guardrail
corbits config set --confirm-above-usd 0.25
```

Corbits stores config at `~/.config/corbits/config.toml` or
`$XDG_CONFIG_HOME/corbits/config.toml`. Use `--config <path>` on `config`
subcommands when you need a different file.

### Check Balance

```bash
corbits balance
corbits balance --asset USDC
corbits balance --network mainnet-beta --address "$(solana address)"
corbits balance --format json
```

By default, `balance` uses the active wallet, configured payment network, and
that network's default payment asset.

### Call Paid Endpoints

`call` wraps the real system `curl` or `wget`. It detects
`402 Payment Required`, builds the x402 payment header, and retries once. The
CoinGecko example below is a live x402 endpoint that returns a payment
challenge before any paid retry.

```bash
# Inspect first, without paying
ENDPOINT_URL="https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=solana&vs_currencies=usd"
corbits call --inspect curl "$ENDPOINT_URL"
corbits call --inspect --format json curl "$ENDPOINT_URL"

# Pay and retry
corbits call curl "$ENDPOINT_URL"
corbits call --yes curl "$ENDPOINT_URL"
corbits call --asset USDC curl "$ENDPOINT_URL"

# Preserve normal curl and wget shape
corbits call curl "$ENDPOINT_URL" -H "Accept: application/json"

corbits call wget "$ENDPOINT_URL"
```

Successful responses keep the wrapped client's stdout/stderr behavior. If the
paid retry still returns `402`, Corbits exits non-zero and prints an error.

Options:

- `--yes` skips interactive confirmation prompts.
- `--payment-info` prints payment metadata to stderr after a successful paid retry.
- `--save-response` stores the successful paid response body in local history.
- `curl --next` is rejected because Corbits cannot safely retry multi-transfer calls.
- For `wget`, Corbits injects `--server-response` when needed so it can detect
  the challenge.

### Flex Prepaid Sessions

Flex is Faremeter's payment scheme for prepaid escrow and off-chain
authorization in variable-cost or high-frequency flows. See the
[Faremeter Flex Overview](https://docs.faremeter.xyz/flex/overview) for the
scheme, escrow, session key, and settlement model.

If `corbits --help` does not list `flex`, start with the Flex overview and use a
Flex-enabled Corbits build for session management. Flex-enabled builds expose:

```bash
corbits flex status
corbits flex status --format json
corbits flex topup <session-id> --amount 0.25
corbits flex topup <session-id> --amount 0.25 --yes
```

In table output, `Total Deposited` is the lifetime amount added to the session.
`Available` is the currently spendable balance after pending usage and
settlements.

For the protocol model, use the Faremeter docs. For CLI work, use:

- `corbits flex status` - inspect stored sessions.
- `corbits flex topup` - add prepaid balance.

### Review Paid-Call History

```bash
corbits history
corbits history --wallet "$(solana address)"
corbits history --network solana-devnet --host exa.api.corbits.dev
corbits history --resource /v1/web/search
corbits history --since 1713782400 --until 2026-04-21T12:00:00Z
corbits history --min-amount 0.001 --max-amount 5 --limit 50
corbits history show 3
corbits history --format json
```

Corbits stores history at `$XDG_DATA_HOME/corbits/history.jsonl` or
`~/.local/share/corbits/history.jsonl`. Table output includes the stable `#`
index used by `history show <index>`.

### Output Formats

Use `--format` when another tool, script, or agent needs to read Corbits
results. Every command supports `table`, `json`, and `yaml`.

When `--format` is omitted, Corbits chooses the output format in this order:

1. The explicit `--format` flag
2. `json` when `NO_DNA` is set to a non-empty value
3. The configured default from `corbits config`
4. `table`

```bash
NO_DNA=1 corbits discover
NO_DNA=1 corbits inspect 73
corbits call --payment-info --format json curl "$ENDPOINT_URL"
```

With `--payment-info`, Corbits prints structured payment metadata without
changing the wrapped response on stdout.

## Command Reference

| Command                        | Use it for                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| `corbits discover [query]`     | Search or list registered x402-gated services.                  |
| `corbits inspect <proxy-id>`   | Inspect a proxy, endpoints, pricing, and OpenAPI spec.          |
| `corbits config show/init/set` | Manage local payment network, wallet, RPC, and format settings. |
| `corbits balance`              | Check a token balance for the configured or specified wallet.   |
| `corbits call curl ...`        | Run a paid `curl` request through x402 handling.                |
| `corbits call wget ...`        | Run a paid `wget` request through x402 handling.                |
| `corbits history`              | Review locally saved paid-call history.                         |
| `corbits flex status/topup`    | Inspect or fund Flex sessions in Flex-enabled builds.           |

Useful flags:

```bash
corbits --version
corbits --help
corbits discover --help
corbits call --help
```

## Development

Requires Node.js 18+ and pnpm.

```bash
pnpm install
make
make format
make clean
```

`make` runs build, lint, and tests. Do not skip git hooks when committing.

## License

LGPL-3.0-or-later
