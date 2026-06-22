# Corbits CLI

<p align="center">
  <img src="assets/corbits-ascii.svg" alt="Corbits CLI ASCII banner" />
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#common-workflows">Common Workflows</a> ·
  <a href="#flex-prepaid-sessions">Flex</a> ·
  <a href="#command-reference">Command Reference</a> ·
  <a href="#development">Development</a>
</p>

Command-line client for discovering x402-gated APIs, inspecting payment
requirements, and paying with `curl` or `wget`.

Prices are displayed in USDC.

## Install

Install `@corbits/cli` globally to use the `corbits` command directly:

```bash
npm install -g @corbits/cli
corbits --help
```

You can also run the CLI without installing it with `npx`:

```bash
npx @corbits/cli --help
npx @corbits/cli discover
```

The examples below use the global `corbits` command. If you prefer `npx`,
replace `corbits` with `npx @corbits/cli`.

## Quick Start

Make a paid request and review the local history entry.

The examples use the Solana CLI default keypair and a live x402 endpoint found
with Corbits discovery. Use your own wallet and inspect the payment challenge
before paying. Replace `SEARCH_TERM`, `PROXY_ID`, and `ENDPOINT_URL` with
values from discovery and inspect output.

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
corbits discover SEARCH_TERM
corbits inspect PROXY_ID

# 4. Probe a live x402 challenge without paying
ENDPOINT_URL="ENDPOINT_URL"
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
3. `call --inspect` parsed the live x402 challenge without paying.
4. `call` signed a payment with the configured wallet and retried the request.
5. `history` showed local paid-call metadata. Use the table's `#` value with
   `history show` to inspect one entry.

## Common Workflows

Start here when you already know what you want to do.

| Workflow                          | Command to start with                   |
| --------------------------------- | --------------------------------------- |
| Find a paid API                   | `corbits discover`                      |
| Inspect pricing before paying     | `corbits inspect PROXY_ID`              |
| Configure a payment wallet        | `corbits config init`                   |
| Check funds                       | `corbits balance`                       |
| Probe a live challenge            | `corbits call --inspect curl`           |
| Make a paid request               | `corbits call curl`                     |
| Check Flex sessions               | `corbits flex status`                   |
| Review paid-call history          | `corbits history`                       |
| Choose output formats             | `--format json` or `NO_DNA=1`           |
| See every command in compact form | [Command Reference](#command-reference) |

### Find APIs

```bash
corbits discover
corbits discover SEARCH_TERM
corbits discover --tag dex
corbits discover --format json
```

Search results include matching proxies and endpoints. Use the proxy ID with
`inspect`.

### Inspect Pricing and OpenAPI

```bash
corbits inspect PROXY_ID
corbits inspect PROXY_ID --openapi
corbits inspect PROXY_ID --format json
NO_DNA=1 corbits inspect PROXY_ID
```

`inspect` shows proxy metadata, endpoints, schemes, and prices. `--openapi`
prints the upstream OpenAPI spec as YAML by default, or JSON with
`--format json`.

### Configure Wallets

Use `--solana-*` wallet flags for Solana networks and `--evm-*` wallet flags
for EVM networks. Choose one wallet source: a local keypair path or an OWS
wallet ID.

```bash
# Local Solana keypair
corbits config init \
  --network mainnet-beta \
  --solana-address "$(solana address)" \
  --solana-path ~/.config/solana/id.json \
  --rpc-url https://api.mainnet-beta.solana.com

# Solana OWS wallet
corbits config init \
  --network devnet \
  --solana-address "$(solana address)" \
  --solana-ows primary-solana

# EVM keypair or OWS wallet
corbits config set \
  --network base \
  --evm-address 0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --evm-path ~/.config/corbits/keys/base.key

corbits config set \
  --evm-address 0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --evm-ows primary-evm

# Spending guardrail
corbits config set --confirm-above-usd 0.25
```

Corbits stores config at `~/.config/corbits/config.toml` or
`$XDG_CONFIG_HOME/corbits/config.toml`. Use `--config PATH` on `config`
subcommands when you need a different file.

`config show` respects `--format` and the configured default format. Table
output prints the derived payment and wallet summary plus a wallet table. JSON
and YAML output include the config path and effective expanded wallet path when
the active wallet uses a keypair.

### Check Balance

```bash
corbits balance
corbits balance --asset USDC
corbits balance --network mainnet-beta --address "$(solana address)"
corbits balance --format json
```

By default, `balance` uses the active wallet, configured payment network, and
that network's default payment asset. Use `--network` and `--address` together
to query a wallet outside the active config.

### Call Paid Endpoints

`call` wraps the real system `curl` or `wget`. It detects
`402 Payment Required`, builds the x402 payment header, and retries once. Use
`discover` and `inspect` to choose an endpoint that returns a payment challenge
before any paid retry.

```bash
# Find and inspect the catalog entry first
corbits discover SEARCH_TERM
corbits inspect PROXY_ID

# Inspect first, without paying
ENDPOINT_URL="ENDPOINT_URL"
corbits call --inspect curl "$ENDPOINT_URL"
corbits call --inspect --format json curl "$ENDPOINT_URL"

# Pay and retry
corbits call curl "$ENDPOINT_URL"
corbits call --yes curl "$ENDPOINT_URL"
corbits call --asset USDC curl "$ENDPOINT_URL"

# Preserve normal curl and wget shape
corbits call curl "$ENDPOINT_URL" -H "Accept: application/json"
corbits call wget "$ENDPOINT_URL"

# Flex endpoints returned by discovery use the same wrapper
FLEX_ENDPOINT_URL="https://<flex-endpoint-from-discovery>"
corbits call --inspect --format json curl "$FLEX_ENDPOINT_URL"
corbits call --flex-session SESSION_ID curl "$FLEX_ENDPOINT_URL"
```

Successful responses keep the wrapped client's stdout/stderr behavior. If the
paid retry still returns `402`, Corbits exits non-zero and prints an error.

Options:

- `--yes` skips interactive confirmation prompts after you have reviewed the
  payment.
- `--payment-info` prints payment metadata to stderr after a successful paid
  retry.
- `--save-response` stores the successful paid response body in local history.
- `curl --next` is rejected because Corbits cannot safely retry multi-transfer
  calls.
- For `wget`, Corbits injects `--server-response` when needed so it can detect
  the challenge.

### Flex Prepaid Sessions

Flex is Faremeter's payment scheme for prepaid escrow and off-chain
authorization in variable-cost or high-frequency flows. See the
[Faremeter Flex Overview](https://docs.faremeter.xyz/flex/overview) for the
scheme, escrow, session key, and settlement model.

```bash
corbits flex status
corbits flex status --format json
corbits flex topup SESSION_ID --amount 0.25
corbits flex topup SESSION_ID --amount 0.25 --yes
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
corbits history show HISTORY_INDEX
corbits history --format json
```

Corbits stores history at `$XDG_DATA_HOME/corbits/history.jsonl` or
`~/.local/share/corbits/history.jsonl`. Table output includes the stable `#`
index used by `history show HISTORY_INDEX`.

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
NO_DNA=1 corbits inspect PROXY_ID
corbits call --payment-info --format json curl "$ENDPOINT_URL"
```

With `--payment-info`, Corbits prints structured payment metadata without
changing the wrapped response on stdout.

## Command Reference

| Command                        | Use it for                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| `corbits discover [query]`     | Search or list registered x402-gated services.                  |
| `corbits inspect PROXY_ID`     | Inspect a proxy, endpoints, pricing, and OpenAPI spec.          |
| `corbits config show/init/set` | Manage local payment network, wallet, RPC, and format settings. |
| `corbits balance`              | Check a token balance for the configured or specified wallet.   |
| `corbits call curl ...`        | Run a paid `curl` request through x402 handling.                |
| `corbits call wget ...`        | Run a paid `wget` request through x402 handling.                |
| `corbits history`              | Review locally saved paid-call history.                         |
| `corbits flex status/topup`    | Inspect or fund Flex sessions.                                  |

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

## Agent Skill

This repo includes a `corbits-cli` agent skill under `skills/corbits-cli`.
Install it with the Skills CLI:

```bash
npx skills add https://github.com/corbits-infra/cli --skill corbits-cli
```

If your agent does not use the Skills CLI, copy `skills/corbits-cli/SKILL.md`
into its skills directory.

## License

LGPL-3.0-or-later
