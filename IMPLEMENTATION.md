# Corbits CLI Implementation

## Runtime and Tooling

The CLI is a TypeScript ESM package published as `@corbits/cli`. The executable
entry point is `dist/index.js`, exposed through the `corbits` bin entry.

Core tooling:

- Node.js 18+.
- pnpm.
- TypeScript.
- `cmd-ts` for command definitions.
- `arktype` for runtime validation.
- `cli-table3` for table output.
- `yaml` for YAML output.
- `smol-toml` for config serialization.
- Tap for tests.

The required verification command is:

```bash
make
```

`make` runs formatting checks, ESLint, TypeScript builds for source and tests,
and the Tap test suite.

## Source Layout

```text
src/index.ts                  CLI entry point and top-level error handling
src/commands/                 command handlers
src/api/                      Corbits discovery API client and schemas
src/config/                   config schema, load/save, and display
src/flags.ts                  shared output format flag resolution
src/output/                   table, JSON, YAML, price, and token formatting
src/process/                  curl/wget wrapping, capture, and request parsing
src/payment/                  payment selection, signing, balance, OWS support
src/history/                  paid-call history persistence and filtering
tests/                        Tap tests
```

## Entry Point

`src/index.ts` loads the package version from `package.json`, registers
subcommands with `cmd-ts`, and runs the app against `process.argv.slice(2)`.

Top-level errors are rendered consistently:

- `APIError`: `API error (<status>): ...`
- `ValidationError`: `Unexpected API response: ...`
- `ConfigError`: `Config error: ...`
- Other errors: `Error: ...`

The entry point sets `process.exitCode = 1` on failure rather than throwing past
the CLI boundary.

## Discovery API Implementation

`src/api/client.ts` contains the API request helper. It builds URLs from the
resolved base URL, uses global `fetch`, and validates JSON responses with
schemas from `src/api/schemas.ts`.

Endpoints used:

- `GET /api/v1/search?q=<query>`
- `GET /api/v1/proxies?cursor=<cursor>&limit=100`
- `GET /api/v1/proxies/:id`
- `GET /api/v1/proxies/:id/openapi`
- `GET /api/v1/proxies/:id/endpoints?cursor=<cursor>&limit=100`

Paginated list helpers collect all pages before returning. Validation failures
are reported as `ValidationError`.

Current discovery schema fields:

- Proxy: `id`, `name`, optional `org_slug`, `default_price`,
  `default_scheme`, `tags`, `url`.
- Proxy detail: proxy fields plus `endpoint_count`.
- Endpoint: `id`, `path_pattern`, optional `description`, optional `price`,
  optional `scheme`, `tags`.
- Search endpoint: endpoint fields plus `proxy_id`, `proxy_name`, optional
  `org_slug`.
- Pagination: optional `nextCursor`, `hasMore`.

## Output Format Resolution

`src/flags.ts` defines the shared `--format` / `-f` flag and resolves output
format with this precedence:

1. Explicit flag.
2. `NO_DNA` environment variable when it is not empty, `0`, or `false`.
3. Configured default format from local config.
4. `table`.

`src/output/format.ts` centralizes table, JSON, YAML, price, and token amount
formatting. Discovery prices are represented as micro-USDC numbers and rendered
as dollar amounts with six decimal places.

## Config Implementation

Config defaults to:

```text
$XDG_CONFIG_HOME/corbits/config.toml
~/.config/corbits/config.toml
```

`src/config/store.ts` owns path resolution, file load, permission warnings, and
atomic save through a temporary file plus rename. Saved config files are written
with mode `0600`.

`src/config/schema.ts` owns parsing, normalization, validation, and resolution.

Supported payment networks:

- `devnet` displayed as `solana-devnet`.
- `mainnet-beta` displayed as `solana-mainnet-beta`.
- `localnet` displayed as `solana-localnet`.
- `base`.
- `base-sepolia`.

Recognized aliases include `solana`, `solana-mainnet`, `solana-devnet`,
`solana-localnet`, and CAIP-2 values that translate to supported legacy network
names.

Default RPC URLs:

- `devnet`: `https://api.devnet.solana.com`
- `mainnet-beta`: `https://api.mainnet-beta.solana.com`
- `localnet`: `http://127.0.0.1:8899`
- `base`: `https://mainnet.base.org`
- `base-sepolia`: `https://sepolia.base.org`

Config structure:

```toml
version = 1

[preferences]
format = "table"
api_url = "https://api.corbits.dev"

[payment]
network = "devnet"

[payment.rpc_url_overrides]
devnet = "https://example.solana.rpc"

[spending]
confirm_above_usd = "0.25"

[wallets.solana]
address = "..."
kind = "keypair"
path = "~/.config/corbits/keys/solana.key"

[wallets.evm]
address = "0x..."
kind = "ows"
wallet_id = "primary-evm"
```

Wallet records are discriminated by `kind`:

- `keypair`: `address`, `kind`, `path`.
- `ows`: `address`, `kind`, `wallet_id`.

Config parsing rejects unknown top-level, section, and wallet keys. It also
validates URL fields, output format, spending amount shape, payment network,
wallet family requirements, and mutually exclusive wallet source fields.

## Command Implementation

### `discover`

Implementation file: `src/commands/discover.ts`.

Behavior:

- Resolves output format and API base URL.
- Calls search when a query is present.
- Calls paginated proxy listing when no query is present.
- Applies optional tag filtering to proxies and endpoints.
- Prints no-results text for empty table output.
- Returns raw arrays or `{ proxies, endpoints }` in JSON/YAML depending on
  whether the user searched.

### `inspect`

Implementation file: `src/commands/inspect.ts`.

Behavior:

- Resolves API base URL.
- With `--openapi`, fetches and prints `data.spec`.
- Without `--openapi`, fetches proxy detail and all endpoint pages.
- Prints `{ proxy, endpoints }` for structured formats.
- Prints a proxy summary and endpoint table for table format.

### `config`

Implementation file: `src/commands/config.ts`.

Subcommands:

- `config show`: load and display current config, or show setup help if config
  is missing.
- `config init`: create initial config; no-ops when config already exists.
- `config set`: update existing config; fails if config is missing.

Mutation flags include network, RPC URL, Solana wallet fields, EVM wallet
fields, output format, API URL, and spending confirmation threshold.

Mutation output uses the configured effective output format after save, so a
user who sets default JSON immediately sees JSON output for the mutation result.

### `balance`

Implementation file: `src/commands/balance.ts`.

Behavior:

- If `--address` is provided, `--network` is required.
- If `--network` is provided without `--address`, the configured wallet must be
  from the same wallet family as that network.
- Asset defaults to the configured payment asset or the selected network's
  default asset.
- Asset input may be a supported symbol or known asset address.
- Output is a single balance record.

### `call`

Implementation file: `src/commands/call.ts`.

Supported wrapped clients:

- `curl`
- `wget`

Top-level options:

- `--inspect`: parse and print x402 payment requirements without paying.
- `--payment-info`: print paid-call metadata to stderr after successful retry.
- `--save-response`: persist the successful paid retry body with history.
- `--yes`: bypass interactive spending confirmation.
- `--asset`: override the configured preferred payment asset for the call.
- `--format`: output format for inspection mode.

Implementation sequence:

1. Reject `--asset` with `--inspect`.
2. For inspect mode, strip a wrapped-client inline `--format` / `-f` intended
   for Corbits inspection output.
3. Run the wrapped client once.
4. If the request completes, pass through output and exit code.
5. If inspect mode receives a payment challenge, print parsed requirements and
   exit without loading config or paying.
6. If the wrapped client reports a payment rejection, print the rejection.
7. If the request returns a payment challenge in pay mode, load required config.
8. If `--save-response` is set, reject incompatible file-output flags.
9. Evaluate spending confirmation policy.
10. Run preflight balance check.
11. Build payment retry header.
12. Retry once with the payment header.
13. Pass through retry output and optional payment metadata.
14. Append paid-call history when retry succeeds.

The retry streams output by default. It buffers output when `--save-response` is
enabled so the response body can be persisted.

### `history`

Implementation file: `src/commands/history.ts`.

List filters:

- `--wallet`
- `--network`
- `--host`
- `--resource`
- `--min-amount`
- `--max-amount`
- `--since`
- `--until`
- `--limit`

`history show <index>` reads the stable line index shown by list output. It
accepts only `--format`; list filters are rejected in detail mode.

Time filters accept Unix seconds, Unix milliseconds, or ISO datetime strings.
Amount filters are interpreted as displayed token amounts, not raw base units.

## Process Wrapping Implementation

`src/process/wrapped-client.ts` builds `runWrappedClient` with Node process and
filesystem dependencies. It checks that the wrapped executable exists in `PATH`
before running it.

The process layer has client-specific modules:

- `src/process/curl.ts`
- `src/process/wget.ts`
- `src/process/request-info.ts`
- `src/process/output-target.ts`
- `src/process/capture.ts`

Request parsing extracts:

- First HTTP/HTTPS URL.
- Headers.
- Method.
- Body data where supported.

`curl --next` is rejected because it represents multiple transfers. `wget`
server-response output is enabled when needed so the wrapper can detect HTTP
status and payment headers.

The retry header is injected as an additional wrapped-client header. The wrapper
returns structured run outcomes so the command layer can distinguish completed
requests, payment-required responses, payment rejections, and unsupported
challenge flows.

## Payment Implementation

Payment code lives under `src/payment`.

Key modules:

- `requirements.ts`: known asset lookup, payment requirement normalization, and
  display helpers.
- `signer.ts`: x402 challenge parsing, requirement selection, wallet handler
  construction, retry header creation, and payment metadata extraction.
- `balance.ts`: balance lookup and preflight balance checks.
- `networks.ts`: network mapping helpers.
- `ows.ts`: Open Wallet Standard payment handler integration.

Payment libraries:

- `@faremeter/types` for x402 types and normalization.
- `@faremeter/payment-solana` and `@faremeter/payment-evm` for payment handler
  creation.
- `@faremeter/wallet-solana` and `@faremeter/wallet-evm` for local wallet
  adapters.
- `@faremeter/info` for network, asset, and token metadata.
- `@solana/web3.js`, `@solana/spl-token`, and `viem` for chain-specific
  primitives.

Supported default payment asset is USDC. Solana payment requirement lookup also
recognizes several known SPL token symbols for requirement display and matching.
EVM matching currently recognizes USDC.

Spending confirmation compares normalized USD-equivalent amounts as decimal
strings to avoid floating-point rounding. Assets that cannot be normalized
safely fail before signing. `EURC` is intentionally exempt from the
USD-threshold check.

## History Implementation

History defaults to:

```text
$XDG_DATA_HOME/corbits/history.jsonl
~/.local/share/corbits/history.jsonl
```

Saved responses are stored relative to the history directory:

```text
history-responses/<record-id>.txt
```

History records are validated with `arktype` before append. A record includes:

- Unique ID.
- Timestamp in milliseconds.
- Wrapped tool.
- Method.
- URL.
- Host.
- Resource path.
- Response status.
- Payment status.
- Amount and asset fields.
- Network.
- Wallet address and wallet kind.
- Optional transaction signature.
- Optional response path.

List views skip malformed history lines. Detail views validate the selected line
and reject unsafe or missing saved-response paths.

## Security and Safety Notes

- Config files are saved with `0600` permissions.
- Existing config files with group or world permissions produce a warning.
- Local keypair material is read only when the active wallet requires it for a
  payment handler.
- Config parsing rejects unknown keys to avoid silently ignoring misspelled
  security-relevant fields.
- Wrapped calls only pay after an observed x402 challenge.
- Spending confirmation refuses unsafe USD normalization before signing.
- Saved response paths must remain inside the history response directory.

## Testing

The test suite covers command behavior, config parsing, API client behavior,
payment helpers, process wrapping behavior, history storage/filtering, and
output formatting.

Run:

```bash
make
```

Manual paid-call scenarios are documented in `TESTING.md`. Those commands use
the local build:

```bash
node dist/index.js
```

Manual paid-call testing should happen only after `make` succeeds and after
confirming the active wallet/network with:

```bash
node dist/index.js config show
```
