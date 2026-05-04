# Corbits CLI Architecture

## System Context

The CLI is a local command-line boundary around three external systems:

- Corbits discovery API: lists proxies, endpoints, and upstream OpenAPI specs.
- x402-gated services: return payment challenges and accept payment headers.
- Payment infrastructure: Solana or EVM RPC endpoints plus wallet backends used
  to sign and submit payments.

The codebase is organized around command handlers and small domain modules. The
command layer owns argument parsing and output shape. Domain modules own config,
API access, process wrapping, payment handling, and history persistence.

## Command Surface

The entry point registers these commands:

- `discover`: search and list x402-gated proxies/endpoints.
- `inspect`: show proxy detail, endpoint tables, and OpenAPI specs.
- `config`: initialize, update, and display local Corbits config.
- `call`: run `curl` or `wget` with x402 payment handling.
- `balance`: report token balance for the configured or specified wallet.
- `history`: inspect locally saved paid-call history.

All commands share output format resolution through the flags layer.

## Major Components

### Command Layer

Command handlers live under `src/commands`. They are responsible for:

- Declaring CLI arguments.
- Calling the appropriate domain module.
- Choosing the output shape for table, JSON, or YAML.
- Converting expected domain failures into actionable user messages.

The top-level entry point centralizes handling for API errors, validation
errors, and config errors so command handlers can throw when a lower layer has
the clearest message.

### Discovery API Client

The API client is the boundary for Corbits discovery API data. It owns:

- Base URL resolution from local config or default API URL.
- HTTP requests to `/api/v1/search`, `/api/v1/proxies`,
  `/api/v1/proxies/:id`, `/api/v1/proxies/:id/endpoints`, and
  `/api/v1/proxies/:id/openapi`.
- Pagination for proxy and endpoint listing.
- Response validation before data enters the rest of the CLI.

The architecture treats API responses as untrusted external input until they
pass schema validation.

### Config

Config is the local source of truth for user preferences and payment defaults.
It contains:

- `preferences.format`: default output format.
- `preferences.api_url`: Corbits discovery API base URL.
- `payment.network`: selected payment network.
- `payment.rpc_url_overrides`: optional per-network RPC URL overrides.
- `spending.confirm_above_usd`: optional interactive confirmation threshold.
- `wallets.solana` and `wallets.evm`: wallet records for supported families.

Config resolution derives an active wallet from the selected payment network.
The selected network determines wallet family, default asset, and default RPC
URL. Network-scoped RPC overrides apply only to their matching network.

### Process Wrapping

The process layer wraps supported system HTTP clients instead of replacing them.
It owns:

- Tool normalization for `curl` and `wget`.
- Argument validation and request metadata extraction.
- Header and body capture needed to reproduce a request.
- First-attempt execution and 402 detection.
- Paid retry execution with an injected payment header.
- Streaming or buffered output behavior depending on whether response saving is
  enabled.

The wrapper preserves ordinary stdout/stderr behavior for successful un-gated
requests. It rejects request shapes it cannot safely pay for, such as
multi-transfer `curl --next` invocations and `--save-response` combined with
file-output flags.

### Payment

The payment layer turns a validated x402 challenge into a retry header. It owns:

- Parsing x402 v1 and v2 payment-required responses.
- Normalizing payment requirements.
- Matching requirements against the active network and requested asset.
- Constructing Solana or EVM payment handlers.
- Reading local keypair wallet material when the active wallet is keypair based.
- Building Open Wallet Standard payment handlers when the active wallet is OWS
  based.
- Reporting selection mismatches and unsupported payment metadata clearly.

The selected payment requirement is the invariant that flows into signing. Once
selected, downstream payment code should not re-decide network or asset policy.

### Balance

The balance layer resolves a balance lookup target from either:

- The active config wallet and network.
- An explicit `--network` plus `--address` pair.
- The active wallet on a different network of the same wallet family.

It resolves supported asset symbols or addresses for the target network, then
queries the relevant payment infrastructure for the balance.

### History

History is a local append-only audit log for successful paid retries. It owns:

- Building normalized paid-call records.
- Persisting records as JSON lines.
- Optionally storing response bodies in a side directory when requested.
- Filtering entries by wallet, network, host, resource, time, and displayed
  amount range.
- Reading individual history entries by stable line index.

Malformed history lines are skipped in list views. Detail views throw on a
malformed selected line because the user explicitly requested that entry.

### Output

The output layer owns:

- Table rendering.
- JSON rendering.
- YAML rendering.
- Price and token-amount display formatting.

Commands should pass already-selected domain data to the output layer rather
than embedding serialization details deep in domain code.

## Data Flow

### Discovery and Inspection

```text
CLI args
  -> command handler
  -> resolve output format
  -> resolve Corbits API base URL
  -> fetch and validate API response
  -> optional command-level filtering
  -> table, JSON, or YAML output
```

### Paid Call

```text
CLI args
  -> run wrapped curl/wget once
  -> if completed, pass through output and exit code
  -> if inspect mode and payment challenge, print requirement details and exit
  -> if payment challenge in pay mode, load config
  -> select payment requirement for configured network/asset
  -> enforce spending confirmation policy
  -> run balance preflight
  -> build x402 payment retry header
  -> run wrapped client once more with payment header
  -> pass through retry output and exit code
  -> append history when retry succeeds
```

The paid call path retries only once. A second `402` or unsupported challenge is
reported as a payment failure rather than silently looping.

### Config Resolution

```text
Config TOML
  -> parse and validate schema
  -> normalize payment network aliases
  -> validate wallets and RPC URL overrides
  -> derive payment family, default asset, RPC URL, and active wallet
  -> command-specific use
```

Config validation happens at the file boundary. Internal modules receive parsed
and resolved config objects rather than raw TOML values.

### History Persistence

```text
Successful paid retry
  -> build history record from request, payment, response, wallet, network
  -> optionally write response body to history-responses/<record-id>.txt
  -> append JSONL record
  -> warn, but do not fail the paid call, if history persistence fails
```

The user paid and received a response before history persistence happens, so a
history write failure is warning-level rather than a paid-call failure.

## Invariants

- External API responses must be validated before use.
- Config files must be parsed, normalized, and resolved before command logic
  relies on them.
- Payment network determines wallet family.
- A configured payment network must have a wallet for its family.
- RPC URL overrides are network scoped.
- `call` supports only `curl` and `wget`.
- `call` pays only after observing a payment challenge.
- `call --inspect` must never sign or submit payment.
- Paid retry happens at most once per `call` invocation.
- `--save-response` requires buffered retry output and is incompatible with
  wrapped-client file-output flags.
- History records are written only for successful paid retries.
- Output format is resolved once per command and then passed through explicitly.

## Failure Modes

- Discovery API request fails: raise an API error with HTTP status and body.
- Discovery API response does not match schema: raise a validation error.
- Config is missing: commands that require payment config fail with setup help.
- Config contains unknown keys or invalid values: fail at parse time.
- Wrapped executable is missing: fail before attempting payment.
- Wrapped request cannot be safely captured: fail before payment.
- Challenge has no requirement matching active network or asset: fail with
  available options.
- Spending threshold cannot be evaluated safely: fail before signing unless the
  asset is explicitly exempted.
- Balance preflight fails: fail before signing.
- Paid retry fails or returns another unsupported challenge: report payment
  failure and exit non-zero.
- History persistence fails after a successful paid retry: warn and preserve the
  paid response outcome.

## Architectural Decisions

### Wrap real HTTP clients

The CLI wraps `curl` and `wget` so users can keep familiar request syntax and
process semantics. This choice keeps the product ergonomic but requires the
process layer to be conservative about which argument shapes it can safely
capture and retry.

### Validate at boundaries

External data enters through API responses, config files, command arguments,
history files, and wrapped process output. Each boundary parses and validates as
early as practical. Internal code should work with normalized values.

### Keep payment selection explicit

The active network and asset come from config or an explicit command override.
The CLI does not choose a cheaper, nearby, or fallback payment option on the
user's behalf. Requirement mismatch is a user-visible failure.

### Prefer local auditability

Paid-call history is stored locally in predictable XDG paths. Response bodies
are not saved unless the user opts in. This gives users auditability without
turning every paid response into persistent local data.

### Preserve machine-readable output

JSON and YAML are first-class formats, not table renderings converted after the
fact. Agent callers depend on structured output and `NO_DNA=1` defaults to JSON
for that use case.

## Extension Points

Likely future extensions should fit existing ownership boundaries:

- Additional discovery filters belong in the command/API boundary.
- Additional wrapped clients belong in the process layer and must define safe
  capture and retry semantics before payment support is exposed.
- Additional payment networks belong in config schema, payment requirement
  resolution, wallet handler construction, balance lookup, and tests together.
- Additional wallet backends belong in payment handler construction and config
  wallet schema.
- Additional history fields belong in the history schema, output views, and
  migration/compatibility policy.
