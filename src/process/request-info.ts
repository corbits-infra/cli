import type {
  WrappedBody,
  WrappedClient,
  WrappedClientDeps,
  WrappedRequestInfo,
} from "./types.js";

function isHTTPURL(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function extractFirstURL(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--url") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return candidate;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      return arg.slice("--url=".length);
    }

    if (isHTTPURL(arg)) {
      return arg;
    }
  }

  return null;
}

function appendHeader(headers: Headers, rawValue: string): void {
  const separator = rawValue.indexOf(":");
  if (separator <= 0) {
    return;
  }

  const key = rawValue.slice(0, separator).trim();
  const value = rawValue.slice(separator + 1).trim();
  if (key.length === 0) {
    return;
  }

  headers.append(key, value);
}

function encodeWrappedBody(body: WrappedBody): Uint8Array {
  return typeof body === "string" ? Buffer.from(body) : body;
}

function combineWrappedBodies(
  current: WrappedBody | undefined,
  next: WrappedBody,
): WrappedBody {
  if (current == null) {
    return next;
  }

  if (typeof current === "string" && typeof next === "string") {
    return `${current}&${next}`;
  }

  return Buffer.concat([
    Buffer.from(encodeWrappedBody(current)),
    Buffer.from("&"),
    Buffer.from(encodeWrappedBody(next)),
  ]);
}

function appendQuerySegments(url: string, segments: string[]): string {
  if (segments.length === 0) {
    return url;
  }

  const hashIndex = url.indexOf("#");
  const baseURL = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const joiner = baseURL.includes("?")
    ? baseURL.endsWith("?") || baseURL.endsWith("&")
      ? ""
      : "&"
    : "?";

  return `${baseURL}${joiner}${segments.join("&")}${hash}`;
}

function encodeFormURLEncodedValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function encodeWrappedBodyForQuery(body: WrappedBody): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

export function parseWrappedRequestHeaders(
  tool: WrappedClient,
  args: string[],
): Headers {
  const headers = new Headers();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (tool === "curl") {
      if (arg === "-H" || arg === "--header") {
        const candidate = args[index + 1];
        if (candidate != null) {
          appendHeader(headers, candidate);
        }
        index += 1;
        continue;
      }
      if (arg.startsWith("--header=")) {
        appendHeader(headers, arg.slice("--header=".length));
        continue;
      }
      if (arg.startsWith("-H") && arg.length > 2) {
        appendHeader(headers, arg.slice(2));
      }
      continue;
    }

    if (arg === "--header") {
      const candidate = args[index + 1];
      if (candidate != null) {
        appendHeader(headers, candidate);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--header=")) {
      appendHeader(headers, arg.slice("--header=".length));
    }
  }

  return headers;
}

async function readBodyFile(
  deps: Pick<WrappedClientDeps, "readBinaryFile">,
  filePath: string,
): Promise<Uint8Array> {
  return deps.readBinaryFile(filePath);
}

async function resolveCurlBody(
  deps: Pick<WrappedClientDeps, "readBinaryFile">,
  value: string,
): Promise<WrappedBody> {
  if (!value.startsWith("@") || value === "@-") {
    return value;
  }

  return readBodyFile(deps, value.slice(1));
}

async function resolveCurlURLEncodedBody(
  deps: Pick<WrappedClientDeps, "readBinaryFile">,
  value: string,
): Promise<string> {
  if (value.startsWith("@") && value !== "@-") {
    return encodeURIComponent(
      Buffer.from(await readBodyFile(deps, value.slice(1))).toString("utf8"),
    );
  }

  const equalsIndex = value.indexOf("=");
  const atIndex = value.indexOf("@");

  if (value.startsWith("=")) {
    return encodeFormURLEncodedValue(value.slice(1));
  }

  if (atIndex > 0 && (equalsIndex === -1 || atIndex < equalsIndex)) {
    const name = value.slice(0, atIndex);
    const filePath = value.slice(atIndex + 1);
    return `${name}=${encodeFormURLEncodedValue(
      Buffer.from(await readBodyFile(deps, filePath)).toString("utf8"),
    )}`;
  }

  if (equalsIndex >= 0) {
    return `${value.slice(0, equalsIndex + 1)}${encodeFormURLEncodedValue(
      value.slice(equalsIndex + 1),
    )}`;
  }

  return encodeFormURLEncodedValue(value);
}

async function resolveWgetBody(
  deps: Pick<WrappedClientDeps, "readBinaryFile">,
  args: string[],
): Promise<{ body: WrappedBody; impliedMethod?: string } | undefined> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--post-data") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: candidate, impliedMethod: "POST" };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--post-data=")) {
      return {
        body: arg.slice("--post-data=".length),
        impliedMethod: "POST",
      };
    }

    if (arg === "--body-data") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: candidate };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--body-data=")) {
      return { body: arg.slice("--body-data=".length) };
    }

    if (arg === "--post-file") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return {
          body: await readBodyFile(deps, candidate),
          impliedMethod: "POST",
        };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--post-file=")) {
      return {
        body: await readBodyFile(deps, arg.slice("--post-file=".length)),
        impliedMethod: "POST",
      };
    }

    if (arg === "--body-file") {
      const candidate = args[index + 1];
      if (candidate != null) {
        return { body: await readBodyFile(deps, candidate) };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--body-file=")) {
      return {
        body: await readBodyFile(deps, arg.slice("--body-file=".length)),
      };
    }
  }

  return undefined;
}

export async function parseWrappedRequestInfo(
  deps: Pick<WrappedClientDeps, "readBinaryFile">,
  tool: WrappedClient,
  args: string[],
): Promise<WrappedRequestInfo> {
  let url = extractFirstURL(args) ?? "";

  if (tool === "curl") {
    let method: string | undefined;
    let body: WrappedBody | undefined;
    let useQueryString = false;
    let hasExplicitMethod = false;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg == null) {
        continue;
      }

      if (arg === "-X" || arg === "--request") {
        const candidate = args[index + 1];
        if (candidate != null) {
          method = candidate.toUpperCase();
          hasExplicitMethod = true;
        }
        index += 1;
        continue;
      }
      if (arg.startsWith("--request=")) {
        method = arg.slice("--request=".length).toUpperCase();
        hasExplicitMethod = true;
        continue;
      }

      if (arg === "-G" || arg === "--get") {
        useQueryString = true;
        continue;
      }

      if (arg === "-I" || arg === "--head") {
        method = "HEAD";
        hasExplicitMethod = true;
        continue;
      }

      if (
        arg === "-d" ||
        arg === "--data" ||
        arg === "--data-raw" ||
        arg === "--data-binary" ||
        arg === "--data-ascii"
      ) {
        const candidate = args[index + 1];
        if (candidate != null) {
          body = combineWrappedBodies(
            body,
            await resolveCurlBody(deps, candidate),
          );
          method ??= "POST";
        }
        index += 1;
        continue;
      }

      if (arg === "--data-urlencode") {
        const candidate = args[index + 1];
        if (candidate != null) {
          body = combineWrappedBodies(
            body,
            await resolveCurlURLEncodedBody(deps, candidate),
          );
          method ??= "POST";
        }
        index += 1;
        continue;
      }

      for (const prefix of [
        "--data=",
        "--data-raw=",
        "--data-binary=",
        "--data-ascii=",
      ]) {
        if (arg.startsWith(prefix)) {
          body = combineWrappedBodies(
            body,
            await resolveCurlBody(deps, arg.slice(prefix.length)),
          );
          method ??= "POST";
          break;
        }
      }
      if (body != null && method === "POST") {
        continue;
      }

      if (arg.startsWith("--data-urlencode=")) {
        body = combineWrappedBodies(
          body,
          await resolveCurlURLEncodedBody(
            deps,
            arg.slice("--data-urlencode=".length),
          ),
        );
        method ??= "POST";
        continue;
      }

      if (arg.startsWith("-d") && arg.length > 2) {
        body = combineWrappedBodies(
          body,
          await resolveCurlBody(deps, arg.slice(2)),
        );
        method ??= "POST";
      }
    }

    const normalizedMethod =
      hasExplicitMethod || !useQueryString ? (method ?? "GET") : "GET";
    if (body != null && useQueryString) {
      url = appendQuerySegments(url, [encodeWrappedBodyForQuery(body)]);
      body = undefined;
    }

    return {
      url,
      requestInit: {
        method: normalizedMethod,
        ...(body == null ? {} : { body }),
      },
    };
  }

  let method: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg == null) {
      continue;
    }

    if (arg === "--method") {
      const candidate = args[index + 1];
      if (candidate != null) {
        method = candidate.toUpperCase();
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length).toUpperCase();
    }
  }

  const bodySource = await resolveWgetBody(deps, args);
  const body = bodySource?.body;
  method ??= bodySource?.impliedMethod ?? (body == null ? "GET" : "POST");

  return {
    url,
    requestInit: {
      method,
      ...(body == null ? {} : { body }),
    },
  };
}
