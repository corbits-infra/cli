export function mockFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText:
        status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  const result = fn();
  if (result instanceof Promise) {
    return result.then(
      () => {
        process.stdout.write = original;
        return captured;
      },
      (err) => {
        process.stdout.write = original;
        throw err;
      },
    );
  }
  process.stdout.write = original;
  return Promise.resolve(captured);
}

export const validProxy = {
  id: 1,
  name: "helius",
  org_slug: null,
  default_price_usdc: 10000,
  default_scheme: "exact",
  tags: ["solana", "rpc"],
  url: "https://helius.api.corbits.dev",
};

export const validProxy2 = {
  id: 2,
  name: "jupiter",
  org_slug: null,
  default_price_usdc: 5000,
  default_scheme: "exact",
  tags: ["solana", "dex"],
  url: "https://jupiter.api.corbits.dev",
};

export const validEndpoint = {
  id: 1,
  path_pattern: "/v1/tokens/*",
  description: "Token info",
  price_usdc: 5000,
  scheme: "exact",
  tags: ["tokens"],
};

export const searchEndpoint = {
  id: 10,
  path_pattern: "/v1/tokens/*",
  tags: ["tokens"],
  proxy_id: 1,
  proxy_name: "helius",
};
