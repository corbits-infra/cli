import { type as arktype, type Type } from "arktype";
import { DEFAULT_API_URL, loadConfig } from "../config/index.js";
import {
  type Proxy,
  type Endpoint,
  SearchResponse,
  ProxiesResponse,
  ProxyDetailResponse,
  ProxyOpenAPIResponse,
  EndpointsResponse,
} from "./schemas.js";

export async function resolveAPIBaseURL(): Promise<string> {
  const loaded = await loadConfig();
  return loaded?.resolved.preferences.apiURL ?? DEFAULT_API_URL;
}

class APIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

async function request<T extends Type>(
  schema: T,
  path: string,
  baseURL?: string,
): Promise<T["infer"]> {
  const resolvedBaseURL = (baseURL ?? (await resolveAPIBaseURL())).replace(
    /\/+$/,
    "",
  );
  const url = `${resolvedBaseURL}${path}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new APIError(res.status, `${res.status} ${res.statusText}: ${body}`);
  }

  const json: unknown = await res.json();
  const result: unknown = schema(json);

  if (result instanceof arktype.errors) {
    throw new ValidationError(result.summary);
  }

  return result;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return (
    "?" +
    new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
  );
}

export function search(q?: string, baseURL?: string) {
  return request(SearchResponse, `/api/v1/search${qs({ q })}`, baseURL);
}

export async function listAllProxies(baseURL?: string): Promise<Proxy[]> {
  const all: Proxy[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await request(
      ProxiesResponse,
      `/api/v1/proxies${qs({ cursor, limit: 100 })}`,
      baseURL,
    );
    all.push(...page.data);
    if (!page.pagination.hasMore || page.pagination.nextCursor == null) break;
    cursor = page.pagination.nextCursor;
  }

  return all;
}

export function getProxy(id: number, baseURL?: string) {
  return request(ProxyDetailResponse, `/api/v1/proxies/${id}`, baseURL);
}

export function getProxyOpenAPI(id: number, baseURL?: string) {
  return request(
    ProxyOpenAPIResponse,
    `/api/v1/proxies/${id}/openapi`,
    baseURL,
  );
}

export async function listAllProxyEndpoints(
  proxyId: number,
  baseURL?: string,
): Promise<Endpoint[]> {
  const all: Endpoint[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await request(
      EndpointsResponse,
      `/api/v1/proxies/${proxyId}/endpoints${qs({ cursor, limit: 100 })}`,
      baseURL,
    );
    all.push(...page.data);
    if (!page.pagination.hasMore || page.pagination.nextCursor == null) break;
    cursor = page.pagination.nextCursor;
  }

  return all;
}

export { APIError, ValidationError, qs };
