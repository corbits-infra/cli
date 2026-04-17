# Testing Paid Calls

This document collects the concrete `corbits call` commands used to test
x402-gated paid requests and `--payment-info` output.

All examples below use the local build:

```bash
node dist/index.js
```

Build first:

```bash
make
```

## Check Active Config

Before testing a paid call, confirm which network and wallet the CLI will use:

```bash
node dist/index.js config show
node dist/index.js config show --format json
```

## Corbits Exa Route

Test the Corbits Exa proxy with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://exa.api.corbits.dev/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"Latest research in x402","text":true}'
```

This should print:

- the upstream API response body to `stdout`
- payment metadata to `stderr`

## Tokens.xyz Assets Search

Test the Tokens.xyz assets search proxy directly with the local CLI:

```bash
node dist/index.js call curl 'https://tokensxyz.api.corbits.dev/v1/assets/search?q=USDC&limit=5'
```

This is a simple GET request that is useful for verifying the proxy route and
for testing shell quoting around query strings.

## StableEnrich Exa Route

Test the StableEnrich Exa route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://stableenrich.dev/api/exa/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"Latest research in LLMs","numResults":5,"contents":{"text":true}}'
```

This route is useful for validating x402 v2 header parsing and paid retry
behavior.

## MetEngine Meteora Pools Route

Test the MetEngine Meteora pools route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS 'https://agent.metengine.xyz/api/v1/meteora/pools/search?query=USDC&pool_type=damm_v2&limit=10'
```

This route is useful for validating the Solana-only payment requirement path.

## Switch To EVM OWS Wallet

If you want to test using the configured EVM OWS wallet instead of the active
Solana wallet, switch the payment network first:

```bash
node dist/index.js config set --network base
node dist/index.js config show
```

Then run the StableEnrich test call:

```bash
node dist/index.js call --payment-info curl -sS https://stableenrich.dev/api/exa/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"Latest research in LLMs","numResults":5,"contents":{"text":true}}'
```

## Capture Response And Payment Output Separately

If you want to inspect the API response body separately from payment metadata:

```bash
node dist/index.js call --payment-info curl -sS https://exa.api.corbits.dev/search \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"Latest research in x402","text":true}' \
  > response.json 2> payment.log
```

## Notes

- Use `-sS` with `curl` so the progress meter does not mix into `stderr`.
- `--payment-info` prints payment metadata only after a successful paid retry.
- The displayed amount is formatted using token decimals when available.
