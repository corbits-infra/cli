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
```

When searching, both matching proxies and endpoints are shown.

### inspect

Show details for a specific proxy, including its endpoints and pricing. Use the proxy ID from `discover` output.

```
corbits inspect 61            # show proxy details and endpoint table
corbits inspect 61 --openapi  # dump the upstream OpenAPI spec
corbits inspect 61 --format json
```

The `--openapi` flag outputs the upstream spec as YAML by default, or as JSON with `--format json`.

### Output formats

All commands support `--format` (`-f`) with values `table` (default), `json`, or `yaml`.

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
