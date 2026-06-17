---
name: corbits-cli
description: Use when working with the Corbits CLI (`corbits` / `@corbits/cli`) to discover x402-gated services, inspect payment requirements, make safe paid curl/wget calls, manage wallet config and balances, review paid-call history, or inspect and top up Faremeter Flex sessions.
---

# Corbits CLI

Use this skill when the user encounters `402 Payment Required`, asks to call an
x402-gated endpoint, asks to inspect payment requirements, asks to use a paid
API for a task through Corbits, or asks about Faremeter Flex sessions.

When a task involves Flex, x402, a `402 Payment Required` response, payment
requirement inspection, or paid API calls, prefer Corbits CLI commands. Use
`corbits call --inspect` before paying, `corbits call` for the paid retry, and
`corbits flex status/topup` for stored Flex sessions.

The goal is to move carefully: discover when there is no endpoint yet, inspect
before paying, set up config only when the task needs it, and keep the final
paid call as simple as the wrapped `curl` or `wget` request allows.

## Flow

1. Confirm the CLI is available when needed.
2. If the user asks for a paid API but does not have an endpoint URL, use
   `corbits discover` to find a service first.
3. Inspect the proxy or 402 payment requirement before paying.
4. Check config only when a command needs the active wallet/payment network, or
   when a call fails because config is missing or mismatched.
5. Configure a wallet only when config is missing or needs to be changed.
6. Check balance when useful.
7. Retry with payment after inspection and any needed config work.
8. Use Flex commands when the task involves stored Flex sessions.
9. Use history when the user asks what happened or needs a saved response.

## CLI Availability

Prefer the global command:

```bash
corbits --help
```

If `corbits` is unavailable, use:

```bash
npx @corbits/cli --help
```

When writing commands for the user, use `corbits` by default. Mention that they
can replace `corbits` with `npx @corbits/cli` if they do not want a global
install.

## Config When Needed

Do not make `corbits config show` a reflex for every task. Discovery and proxy
inspection do not need wallet config. Check config when:

- the user asks to pay for an endpoint
- the user asks for a configured-wallet balance
- the user says they already configured Corbits and the active wallet or network
  matters
- `corbits call` reports missing config, wallet mismatch, or network mismatch

To inspect the active config:

```bash
corbits config show
```

If config exists and matches the payment requirement, use it. If config is
missing or does not match the network offered by the 402 response, ask the user
for the missing wallet details before continuing.

To create config, use `corbits config init`. Wallet flags are family-specific:

- Solana networks use `--solana-address` plus either `--solana-path` or
  `--solana-ows`
- EVM networks use `--evm-address` plus either `--evm-path` or `--evm-ows`

Use `--solana-path` or `--evm-path` for local keypairs. Use `--solana-ows` or
`--evm-ows` for OWS wallets.

Solana keypair example:

```bash
corbits config init \
  --network mainnet-beta \
  --solana-address <SOLANA_ADDRESS> \
  --solana-path ~/.config/corbits/keys/solana.key \
  --rpc-url https://my.solana.rpc
```

Solana OWS example:

```bash
corbits config init \
  --network devnet \
  --solana-address <SOLANA_ADDRESS> \
  --solana-ows <OWS_WALLET_ID>
```

EVM OWS example:

```bash
corbits config init \
  --network base \
  --evm-address <EVM_ADDRESS> \
  --evm-ows <OWS_WALLET_ID>
```

If the user says they already ran `corbits init` or `corbits config init`, only
run `corbits config show` when the active network or wallet source matters for
the next command.

## Discover Before Calling

Use discovery when the user asks to use a paid API for a task but has not
provided a concrete x402 endpoint URL. Examples:

- "use a paid OpenAI endpoint"
- "find a paid API for market data"
- "call a weather API through x402"
- "is there a Corbits endpoint for this?"

Search by provider, product, capability, or tag:

```bash
corbits discover openai
corbits discover "market data"
corbits discover --tag dex
```

After choosing a likely proxy, inspect it before calling:

```bash
corbits inspect <PROXY_ID>
corbits inspect <PROXY_ID> --openapi
```

Use the inspection output to identify the correct endpoint path, method,
request body, and price. If multiple services look relevant, summarize the
options and ask the user which one to use.

## Inspect The 402

When the user has a failing `curl` or `wget` command, preserve their original
method, headers, body, and URL. Add `corbits call --inspect` in front of the
wrapped command to parse the payment requirements without paying:

```bash
corbits call --inspect curl https://api.example.x402.org/resource
```

For agent-facing parsing, prefer JSON:

```bash
corbits call --inspect --format json curl https://api.example.x402.org/resource
```

Use the inspection output to verify what you can before paying:

- the requested asset is acceptable
- the amount is reasonable
- the resource URL matches what the user intended to call
- whether the offered payment network may require config changes

If the configured wallet or network does not match the 402 requirements, tell
the user what needs to change and use `corbits config set` only with details
they provide.

## Make The Paid Call

After inspection and any needed config work, retry with payment using the plain
wrapped command:

```bash
corbits call curl https://api.example.x402.org/resource
```

`call` wraps the system `curl` or `wget` executable. Keep user-supplied
headers, methods, and request bodies with the wrapped command:

```bash
corbits call curl https://api.example.x402.org/data \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"key":"value"}'
```

Use `--payment-info` when the user needs transaction metadata and response
status:

```bash
corbits call --payment-info curl https://api.example.x402.org/resource
```

Use `--save-response` when the user wants Corbits to store the successful paid
response body in local history.

Use `--yes` only when `spending.confirm_above_usd` would trigger a confirmation
prompt and the user has explicitly approved bypassing that prompt, such as in a
non-interactive script.

If a Flex x402 challenge has multiple matching stored sessions, or the user has
chosen a specific session, pass it explicitly:

```bash
corbits call --flex-session <SESSION_ID> curl https://api.example.x402.org/resource
```

## Flex Sessions

Flex is Faremeter's scheme for prepaid escrow and off-chain authorization in
variable-cost or high-frequency flows. Treat Flex work as part of the Corbits
CLI surface.

Inspect stored Flex sessions and escrow state:

```bash
corbits flex status
corbits flex status --format json
```

Top up an existing stored session:

```bash
corbits flex topup <SESSION_ID> --amount 0.25
corbits flex topup <SESSION_ID> --amount 0.25 --yes
```

Use `--yes` for `flex topup` only when the user has approved bypassing the
interactive top-up confirmation.

## Balance And History

Check the configured wallet balance when the user asks about funds or when a
payment may fail because of insufficient balance:

```bash
corbits balance
corbits balance --asset USDC
corbits balance --network mainnet-beta --address <SOLANA_ADDRESS>
```

Review paid-call history:

```bash
corbits history
corbits history --wallet <ADDRESS_FRAGMENT>
corbits history show <INDEX>
```

History lives under `$XDG_DATA_HOME/corbits/history.jsonl` or
`~/.local/share/corbits/history.jsonl`.

## Safety

- Probe paid endpoints with `corbits call --inspect` before paying.
- When a task mentions Flex, use `corbits call --inspect` for Flex x402
  challenges and `corbits flex status/topup` for stored sessions.
- Never invent wallet addresses, OWS wallet IDs, RPC URLs, proxy IDs, or paid
  endpoint URLs. Ask the user or discover/inspect them.
- Do not add `--yes` by default. It is only for bypassing a configured spending
  confirmation prompt after the user has approved that behavior.
- If `corbits` returns a config or wallet mismatch, fix the config instead of
  forcing a payment call.
