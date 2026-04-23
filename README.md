# @corbits/cli

CLI tool for browsing and filtering x402-gated services on the Corbits platform. Queries the discovery API at `https://api.corbits.dev`.

Prices are displayed in USDC.

## Install

Run directly with npx:

```
npx @corbits/cli discover
npx @corbits/cli inspect 61
```

Or install globally:

```
npm install -g @corbits/cli
corbits discover
```

## Commands

### discover

Search for available services or list all registered proxies.

```
corbits discover              # list all proxies
corbits discover openai       # search for proxies matching "openai"
corbits discover --tag dex    # filter by tag (substring, case-insensitive)
corbits discover --format json
NO_DNA=1 corbits discover     # default to JSON for agent callers
```

When searching, both matching proxies and endpoints are shown.

### inspect

Show details for a specific proxy, including its endpoints and pricing. Use the proxy ID from `discover` output.

```
corbits inspect 61            # show proxy details and endpoint table
corbits inspect 61 --openapi  # dump the upstream OpenAPI spec
corbits inspect 61 --format json
NO_DNA=1 corbits inspect 61   # default to JSON for agent callers
```

The `--openapi` flag outputs the upstream spec as YAML by default, or as JSON with `--format json`.

### call

Run the system `curl` or `wget` client against an x402-gated endpoint using the
active wallet from config. Corbits wraps the real executable, detects `402 Payment Required`,
builds the payment header, and retries once with that header attached.

```
corbits call curl https://api.example.x402.org/resource
corbits call curl https://api.example.x402.org/data \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"key":"value"}'
corbits call --yes curl https://api.example.x402.org/resource
corbits call --payment-info curl https://api.example.x402.org/resource
corbits call --save-response curl https://api.example.x402.org/resource
corbits call wget --method=POST https://api.example.x402.org/resource
```

`call` only supports `curl` and `wget`. These are the underlying system CLIs,
not Corbits-owned commands. Corbits preserves the wrapped client's normal
stdout/stderr behavior on successful responses.

For `curl`, multi-transfer invocations with `--next` are rejected because
Corbits cannot retry them safely after a `402` challenge.

For `wget`, Corbits injects `--server-response` when it is missing so it can
detect and handle a `402` challenge automatically.

`call` uses the active wallet resolved from the configured payment network:

- keypair wallets are loaded from the configured local key file
- OWS wallets are resolved by configured wallet name or ID through the local OWS wallet store

If a wrapped request still returns `402` after payment, Corbits exits non-zero
and prints an error.

If `spending.confirm_above_usd` is configured, Corbits inspects the selected
payment option before signing. When the normalized USD-equivalent amount exceeds
that threshold, `call` prompts for confirmation on an interactive terminal.
Use `--yes` to bypass that prompt. Corbits refuses to guess when the selected
asset cannot be normalized safely to USD and tells you to inspect the challenge
first instead. `EURC` is not supported by this spending-limit normalization yet,
so Corbits skips the threshold check for `EURC` payments.

When `--payment-info` is set, successful paid retries also print payment
metadata to `stderr`:

```
Payment:
  amount: 0.001000
  asset: USDC
  network: solana-mainnet-beta
  tx_signature: 5k7...
```

Successful paid retries are also recorded in local history at
`$XDG_DATA_HOME/corbits/history.jsonl` or `~/.local/share/corbits/history.jsonl`.
Use `--save-response` to store the successful paid response body alongside the
history entry. When this flag is set, Corbits buffers the paid retry before
printing it so the response body can be persisted. This flag is not supported
together with `curl -o/--output` or `wget -O/--output-document`, because
Corbits would otherwise need to buffer the paid response and slow delivery.

### history

Inspect locally saved paid-call history.

```
corbits history
corbits history --wallet 7xKX
corbits history --network solana-devnet --host exa.api.corbits.dev
corbits history --since 1713782400 --until 2026-04-21T12:00:00Z
corbits history --min-amount 0.001 --max-amount 5
corbits history show 3
corbits history --format json
```

`history` shows the 20 most recent entries by default. Table output includes the
stable `#` line index used by `history show <index>`. JSON and YAML outputs
include that same `index` field for each listed entry. `--min-amount` and
`--max-amount` filter on the displayed paid amount, so values like `0.003` and
`5` are interpreted as UI amounts rather than raw base units. History records
keep the paid amount in base units on disk, but all CLI output formats render
that amount back to UI units for display.

### config

Inspect and manage the local Corbits config stored at `~/.config/corbits/config.toml`
or `$XDG_CONFIG_HOME/corbits/config.toml`.

```
corbits config show
corbits config show --format json
corbits config init --network mainnet-beta --solana-address 7xKX... --solana-path ~/.config/corbits/keys/solana.key --rpc-url https://my.solana.rpc
corbits config init --network devnet --solana-address 7xKX... --solana-ows primary-solana
corbits config set --evm-address 0x1234 --evm-ows primary-evm
corbits config set --network base
corbits config set --rpc-url https://mainnet.base.org
corbits config set --confirm-above-usd 0.25
corbits config set --format yaml --api-url https://staging.corbits.dev
```

`config show` respects `--format` and the configured default format. Table output prints
the derived payment and wallet summary plus a wallet table; JSON and YAML output include
the config path and effective expanded wallet path when the active wallet uses a keypair.
The config file stores the selected payment network and wallet records. Effective payment
address is resolved from the active wallet, and asset/RPC URL are resolved from network
defaults. `--rpc-url` stores a network-scoped override, so switching networks only applies
the override for the selected network. `--confirm-above-usd` stores a spending
policy that prompts before paying when a selected x402 call exceeds the
configured USD threshold.

### Output formats

All commands support `--format` (`-f`) with values `table`, `json`, or `yaml`.
When `--format` is omitted, the CLI resolves the output format in this order:

1. The explicit `--format` flag, when provided
2. `json` if `NO_DNA` is set to a non-empty value
3. The configured default format from `corbits config`
4. `table` when no config default exists

### Other flags

```
corbits --version
corbits --help
corbits discover --help
```

## Example

```
$ corbits discover openai

┌────┬────────┬───────────┬──────┬────────────────────────────────┐
│ ID │ Name   │ Price     │ Tags │ URL                            │
├────┼────────┼───────────┼──────┼────────────────────────────────┤
│ 61 │ openai │ $0.010000 │      │ https://openai.api.corbits.dev │
└────┴────────┴───────────┴──────┴────────────────────────────────┘

$ corbits inspect 61

openai (ID: 61)
  URL:       https://openai.api.corbits.dev
  Price:     $0.010000
  Scheme:    exact
  Tags:
  Endpoints: 99

┌────┬──────────┬───────────┬───────────┬──────┐
│ ID │ Path     │ Price     │ Scheme    │ Tags │
├────┼──────────┼───────────┼───────────┼──────┤
│ 46 │ ^/evals$ │ (default) │ (default) │      │
│ 47 │ ^/files$ │ (default) │ (default) │      │
│ …  │          │           │           │      │
└────┴──────────┴───────────┴───────────┴──────┘
```

## Development

Requires Node.js 18+ and pnpm.

```
pnpm install    # install dependencies
make            # lint, build, and test
make format     # auto-format with prettier
make clean      # remove build artifacts
```

## License

LGPL-3.0-or-later
