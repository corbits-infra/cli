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

Make a paid request to an x402-gated endpoint using the active wallet from config.

```
corbits call https://api.example.x402.org/resource
corbits call https://api.example.x402.org/data \
  --method POST \
  --header "Content-Type: application/json" \
  --body '{"key":"value"}'
corbits call https://api.example.x402.org/resource --format json
```

`call` uses the active wallet resolved from the configured payment network:

- keypair wallets are loaded from the configured local key file
- OWS wallets are resolved by configured wallet name or ID through the local OWS wallet store

Successful table output prints the HTTP status line followed by the raw response body. `json` and `yaml`
print parsed JSON bodies directly when possible, and otherwise return a structured wrapper with status,
headers, and body text.

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
corbits config set --format yaml --api-url https://staging.corbits.dev
```

`config show` respects `--format` and the configured default format. Table output prints
the derived payment and wallet summary plus a wallet table; JSON and YAML output include
the config path and effective expanded wallet path when the active wallet uses a keypair.
The config file stores the selected payment network and wallet records. Effective payment
address is resolved from the active wallet, and asset/RPC URL are resolved from network
defaults. `--rpc-url` stores a network-scoped override, so switching networks only applies
the override for the selected network.

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
