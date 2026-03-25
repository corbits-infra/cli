# AGENTS.md

Instructions for AI agents working in this repository.

## Project

CLI tool (`@corbitsdev/cli`) for browsing, filtering, and testing x402-gated services via the Bazaar discovery endpoint.

Commands:

- `discover` - query search endpoint, browse/filter services (provider, category, tag, price range)
- Service details: pricing, endpoints, supported tokens, description
- Test a service: make a paid request from CLI with wallet config

Output formats: table (default), JSON, YAML. Wallet configuration via env vars or config file.

## Git

Never skip git hooks. Do not use `GIT_SKIP_HOOKS=true` or `--no-verify` when committing. If hooks fail, fix the underlying issue.

## Build

Run `make` to lint and build. Do not declare a task complete without a passing `make`.
