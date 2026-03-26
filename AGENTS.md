# AGENTS.md

Instructions for AI agents working in this repository.

## Project

CLI tool (`@corbits/cli`) for browsing and filtering x402-gated services via the Corbits discovery API at `https://api.corbits.dev`.

Commands:

- `discover` - search/list proxies and endpoints, filter by tag
- `inspect` - show proxy details, endpoints, and upstream OpenAPI specs

Output formats: table (default), JSON, YAML.

## Git

Never skip git hooks. Do not use `GIT_SKIP_HOOKS=true` or `--no-verify` when committing. If hooks fail, fix the underlying issue.

## Build

Run `make` to lint and build. Do not declare a task complete without a passing `make`.
