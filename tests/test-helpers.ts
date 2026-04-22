import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function mockFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
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
  const original = process.stdout.write.bind(process.stdout);
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
      (err: unknown) => {
        process.stdout.write = original;
        throw err;
      },
    );
  }
  process.stdout.write = original;
  return Promise.resolve(captured);
}

export function captureStdoutBytes(
  fn: () => void | Promise<void>,
): Promise<Uint8Array> {
  const original = process.stdout.write.bind(process.stdout);
  const captured: Uint8Array[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
    return true;
  }) as typeof process.stdout.write;
  const result = fn();
  if (result instanceof Promise) {
    return result.then(
      () => {
        process.stdout.write = original;
        return Buffer.concat(captured);
      },
      (err: unknown) => {
        process.stdout.write = original;
        throw err;
      },
    );
  }
  process.stdout.write = original;
  return Promise.resolve(Buffer.concat(captured));
}

export function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stderr.write;
  const result = fn();
  if (result instanceof Promise) {
    return result.then(
      () => {
        process.stderr.write = original;
        return captured;
      },
      (err: unknown) => {
        process.stderr.write = original;
        throw err;
      },
    );
  }
  process.stderr.write = original;
  return Promise.resolve(captured);
}

export function captureCombinedOutput(
  fn: () => void | Promise<void>,
): Promise<string> {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let captured = "";
  const capture = (chunk: string | Uint8Array) => {
    captured +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      () => {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
        return captured;
      },
      (err: unknown) => {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
        throw err;
      },
    );
  }
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  return Promise.resolve(captured);
}

export function withTempConfigHome(test: {
  teardown(fn: () => Promise<void>): void;
}): string {
  const priorConfigHome = process.env.XDG_CONFIG_HOME;
  const priorNoDna = process.env.NO_DNA;
  const dir = path.join(
    os.tmpdir(),
    `corbits-config-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );

  process.env.XDG_CONFIG_HOME = dir;
  test.teardown(async () => {
    if (priorConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = priorConfigHome;
    }
    if (priorNoDna === undefined) {
      delete process.env.NO_DNA;
    } else {
      process.env.NO_DNA = priorNoDna;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  return dir;
}

export function withTempDataHome(test: {
  teardown(fn: () => Promise<void>): void;
}): string {
  const priorDataHome = process.env.XDG_DATA_HOME;
  const dir = path.join(
    os.tmpdir(),
    `corbits-data-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );

  process.env.XDG_DATA_HOME = dir;
  test.teardown(async () => {
    if (priorDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = priorDataHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  return dir;
}

export async function writeConfig(
  configHome: string,
  body: string,
): Promise<void> {
  await fs.mkdir(path.join(configHome, "corbits"), { recursive: true });
  await fs.writeFile(path.join(configHome, "corbits", "config.toml"), body, {
    mode: 0o600,
  });
}

export async function readTempConfigFile(configHome: string): Promise<string> {
  return fs.readFile(path.join(configHome, "corbits", "config.toml"), "utf8");
}

export const validProxy = {
  id: 1,
  name: "helius",
  org_slug: null,
  default_price: 10000,
  default_scheme: "exact",
  tags: ["solana", "rpc"],
  url: "https://helius.api.corbits.dev",
};

export const validProxy2 = {
  id: 2,
  name: "jupiter",
  org_slug: null,
  default_price: 5000,
  default_scheme: "exact",
  tags: ["solana", "dex"],
  url: "https://jupiter.api.corbits.dev",
};

export const validEndpoint = {
  id: 1,
  path_pattern: "/v1/tokens/*",
  description: "Token info",
  price: 5000,
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
