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

## xAI Image Generation Route

Test the xAI image generation route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://xai.api.corbits.dev/v1/images/generations \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "grok-imagine-image",
    "prompt": "A playful cartoon character coding at a laptop, colorful hoodie, expressive face, clean vector-like style, bright desk setup, screen full of code, high detail"
  }'
```

This route returns JSON with a direct image URL in `data[0].url`. The tested
response shape looked like:

```json
{
  "data": [
    {
      "url": "https://imgen.x.ai/...jpeg",
      "mime_type": "image/jpeg",
      "revised_prompt": ""
    }
  ],
  "usage": {
    "cost_in_usd_ticks": 200000000
  }
}
```

To save the returned image locally:

```bash
node dist/index.js call --payment-info curl -sS https://xai.api.corbits.dev/v1/images/generations \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "grok-imagine-image",
    "prompt": "A playful cartoon character coding at a laptop, colorful hoodie, expressive face, clean vector-like style, bright desk setup, screen full of code, high detail"
  }' \
  > xai-image.json

curl -L "$(jq -r '.data[0].url' xai-image.json)" -o xai-image.jpeg
```

This route is useful for validating that `corbits call` can complete a paid
retry and return a usable image URL.

## QuiverAI Text-To-SVG Route

Test the QuiverAI text-to-SVG route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://quiverai.api.corbits.dev/v1/svgs/generations \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "arrow-1.1",
    "prompt": "Generate a minimalist rocket icon",
    "stream": false
  }'
```

Working `wget` equivalent:

```bash
node dist/index.js call --payment-info wget 'https://quiverai.api.corbits.dev/v1/svgs/generations' \
  --method=POST \
  --header 'Content-Type: application/json' \
  --body-data '{"model":"arrow-1.1","prompt":"Generate a minimalist rocket icon","stream":false}'
```

This route returns JSON with inline SVG content in `data[0].svg`. The tested
response shape looked like:

```json
{
  "id": "da9885b5696649f895ded2cd82feba33",
  "data": [
    {
      "svg": "<svg ...>...</svg>",
      "mime_type": "image/svg+xml"
    }
  ],
  "credits": 20
}
```

To save the returned SVG locally:

```bash
node dist/index.js call --payment-info curl -sS https://quiverai.api.corbits.dev/v1/svgs/generations \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "arrow-1.1",
    "prompt": "Generate a minimalist rocket icon",
    "stream": false
  }' \
  | jq -r '.data[0].svg' > quiver-rocket.svg
```

This route is useful for validating a paid request that returns the final SVG
inline rather than as a task id or external asset URL. For `wget`, prefer
`--method=POST` with `--body-data` for this route.

## Runway Text-To-Image Route

Test the Runway text-to-image route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/text_to_image \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Runway-Version: 2024-11-06' \
  -d '{
    "model": "gemini_2.5_flash",
    "promptText": "A playful cartoon character coding at a laptop, colorful hoodie, expressive face, clean vector-like style, bright desk setup, screen full of code, high detail",
    "ratio": "1024:1024"
  }'
```

This route returns a task id:

```json
{
  "id": "1f5831a8-19cb-4e44-8fb7-72579fb98229"
}
```

Poll the task until it reaches `SUCCEEDED`:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/tasks/1f5831a8-19cb-4e44-8fb7-72579fb98229 \
  -H 'X-Runway-Version: 2024-11-06'
```

The tested task response looked like:

```json
{
  "id": "1f5831a8-19cb-4e44-8fb7-72579fb98229",
  "status": "SUCCEEDED",
  "output": ["https://dnznrvs05pmza.cloudfront.net/...png?_jwt=..."]
}
```

To save the returned image locally:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/tasks/1f5831a8-19cb-4e44-8fb7-72579fb98229 \
  -H 'X-Runway-Version: 2024-11-06' \
  > runway-task.json

curl -L "$(jq -r '.output[0]' runway-task.json)" -o runway-image.png
```

This route is useful for validating a paid task-creation flow where the first
request returns a task id and a follow-up poll returns the final image URL.

## Runway Text-To-Video Route

Test the Runway text-to-video route with `--payment-info` enabled:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/text_to_video \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Runway-Version: 2024-11-06' \
  -d '{
    "model": "veo3.1_fast",
    "promptText": "A playful cartoon character coding at a laptop in a bright studio, animated camera motion, expressive face, colorful hoodie",
    "ratio": "1280:720",
    "duration": 4
  }'
```

This route returns a task id:

```json
{
  "id": "bb02eaad-4e02-4b70-9709-bd69dddb5b28"
}
```

Poll the task until it reaches `SUCCEEDED`:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/tasks/bb02eaad-4e02-4b70-9709-bd69dddb5b28 \
  -H 'X-Runway-Version: 2024-11-06'
```

The tested task response looked like:

```json
{
  "id": "bb02eaad-4e02-4b70-9709-bd69dddb5b28",
  "status": "SUCCEEDED",
  "output": ["https://dnznrvs05pmza.cloudfront.net/...mp4?_jwt=..."]
}
```

To save the returned video locally:

```bash
node dist/index.js call --payment-info curl -sS https://runway.api.corbits.dev/v1/tasks/bb02eaad-4e02-4b70-9709-bd69dddb5b28 \
  -H 'X-Runway-Version: 2024-11-06' \
  > runway-video-task.json

curl -L "$(jq -r '.output[0]' runway-video-task.json)" -o runway-video.mp4
```

This route is useful for validating a paid task-creation flow where the first
request returns a task id and a follow-up poll returns the final video URL.

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
- `--payment-info` confirms that the CLI sent a paid retry and also prints the
  paid response status separately.
- The displayed amount is formatted using token decimals when available.
