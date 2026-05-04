# Corbits CLI Product

## Overview

`@corbits/cli` is the command-line interface for discovering, inspecting, and
calling x402-gated services available through Corbits. It gives developers and
agent runtimes a local tool for finding payable APIs, understanding their
pricing, configuring payment wallets, executing paid requests with familiar
HTTP clients, and auditing paid-call history.

The CLI talks to the Corbits discovery API at `https://api.corbits.dev` by
default. Users can override that API URL in local config for staging or private
deployments.

## Target Users

- Developers exploring x402-gated APIs from a terminal.
- Agent builders that need machine-readable service discovery and inspection.
- Operators validating whether a wallet can pay for services on a supported
  payment network.
- Power users who already know `curl` or `wget` and want payment handling
  without replacing their existing request workflow.

## User Value

The product promise is simple: users should be able to find a payable service,
see what it costs, configure how payment should happen, make a request, and
review what was paid without writing payment protocol glue themselves.

Key value propositions:

- Service discovery: `discover` lists or searches available Corbits proxies and
  endpoints.
- Service inspection: `inspect` shows proxy detail, endpoint pricing, and
  upstream OpenAPI specs.
- Familiar paid execution: `call` wraps the user's system `curl` or `wget`
  invocation and adds x402 payment only when the server requires it.
- Payment control: `config` records the active payment network, wallet source,
  output preference, discovery API URL, RPC overrides, and optional spending
  confirmation policy.
- Balance visibility: `balance` checks the configured wallet or an explicit
  network/address target before users attempt paid calls.
- Local audit trail: `history` lists paid calls, filters them, and can show a
  saved response body for calls made with `--save-response`.
- Agent-friendly output: every command supports `table`, `json`, and `yaml`.
  `NO_DNA=1` defaults output to JSON for agent callers when no explicit format
  is provided.

## Supported Workflows

### Discover a service

Users can list all registered proxies, search by text, or filter by tag:

```bash
corbits discover
corbits discover openai
corbits discover --tag dex
corbits discover --format json
```

Search results include matching proxies and matching endpoints. Tag filtering is
case-insensitive and substring based.

### Inspect a service before use

Users can inspect a proxy by ID from `discover` output:

```bash
corbits inspect 61
corbits inspect 61 --openapi
corbits inspect 61 --format json
```

The default inspection view is optimized for humans: proxy summary first, then
an endpoint table. `--openapi` prints the upstream OpenAPI spec in YAML by
default, or JSON with `--format json`.

### Configure payment

Users initialize config once, then adjust network, wallet, RPC, API URL, default
format, or spending policy over time:

```bash
corbits config init --network devnet \
  --solana-address 7xKX... \
  --solana-path ~/.config/corbits/keys/solana.key

corbits config set --network base
corbits config set --rpc-url https://mainnet.base.org
corbits config set --confirm-above-usd 0.25
corbits config show --format json
```

Config supports Solana and EVM wallet families. A wallet can be backed by a
local keypair file or by an Open Wallet Standard wallet reference.

### Check a balance

Users can check the configured active wallet or provide an explicit target:

```bash
corbits balance
corbits balance --network devnet
corbits balance --network base --address 0x1234...
corbits balance --asset USDC --format yaml
```

This helps users confirm that the active payment account has funds before a paid
request is attempted.

### Call a paid endpoint

Users run `curl` or `wget` through `corbits call`:

```bash
corbits call curl https://api.example.x402.org/resource
corbits call --payment-info curl https://api.example.x402.org/resource
corbits call --save-response curl https://api.example.x402.org/resource
corbits call wget --method=POST https://api.example.x402.org/resource
```

The product behavior is intentionally conservative:

- If the first request succeeds without payment, Corbits passes through the
  wrapped client's normal output and exit code.
- If the first request returns `402 Payment Required`, Corbits selects a payment
  requirement matching the configured network and asset, signs a payment header,
  and retries once.
- If the retry still cannot satisfy the challenge, Corbits exits non-zero.
- If `spending.confirm_above_usd` is set and the selected payment is above that
  threshold, Corbits asks for confirmation on an interactive terminal unless
  `--yes` was provided.
- If a selected asset cannot be safely normalized to USD for a spending check,
  Corbits refuses the call instead of guessing.

### Inspect a payment challenge without paying

Users can probe an x402 endpoint and inspect available payment requirements:

```bash
corbits call --inspect curl https://api.example.x402.org/resource
corbits call --inspect --format json curl https://api.example.x402.org/resource
```

This is useful when a user wants to understand network, asset, amount, scheme,
or resource metadata before allowing a payment.

### Review paid-call history

Successful paid retries are recorded locally:

```bash
corbits history
corbits history --wallet 7xKX
corbits history --network solana-devnet --host exa.api.corbits.dev
corbits history --since 1713782400 --until 2026-04-21T12:00:00Z
corbits history --min-amount 0.001 --max-amount 5
corbits history show 3
```

History gives users a local audit trail of what the CLI paid for, when it paid,
which wallet/network was used, what the response status was, and which resource
was requested. Response bodies are stored only when the user explicitly opts in
with `--save-response`.

## Output Contract

All user-facing commands support:

- `table` for interactive terminal use.
- `json` for agent, script, and programmatic use.
- `yaml` for readable structured output.

When the user omits `--format`, the CLI resolves format in this order:

1. Explicit `--format`.
2. `json` when `NO_DNA` is set to a non-empty, non-zero, non-false value.
3. Configured default format.
4. `table`.

## Product Boundaries

The CLI is not a wallet manager, marketplace UI, or hosted payment service. It
uses local configuration and payment libraries to produce x402 payment headers
for supported networks. The remote service, facilitator, and upstream API remain
responsible for accepting, settling, and fulfilling paid requests.

The CLI also does not attempt to emulate all `curl` and `wget` behavior. It
wraps a supported subset safely enough to detect a single request, observe a
payment challenge, and retry with a payment header. Multi-transfer `curl --next`
requests are rejected because they cannot be retried safely as one paid
operation.

## Success Criteria

- A new user can discover a service, inspect it, configure a wallet, and make a
  paid request from the README and these docs.
- Agent callers can depend on stable JSON/YAML output for command automation.
- Paid-call behavior is explainable: first request, challenge parsing, payment
  requirement selection, preflight, confirmation, retry, history append.
- Spending safeguards prefer refusal over unsafe payment normalization.
- Local files containing config, keys, and history are predictable and
  documented.
