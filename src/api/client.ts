import { type as arktype, type Type } from "arktype";
import {
  type Proxy,
  type Endpoint,
  SearchResponse,
  ProxiesResponse,
  ProxyDetailResponse,
  ProxyOpenapiResponse,
  EndpointsResponse,
} from "./schemas.js";

const BASE_URL = "https://api.corbits.dev";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request<T extends Type<any>>(
  schema: T,
  path: string,
): Promise<T["infer"]> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${body}`);
  }

  const json: unknown = await res.json();
  const result = schema(json);

  if (result instanceof arktype.errors) {
    throw new ValidationError(result.summary);
  }

  return result as T["infer"];
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

export function search(q?: string) {
  return request(SearchResponse, `/api/v1/search${qs({ q })}`);
}

export async function listAllProxies(): Promise<Proxy[]> {
  const all: Proxy[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await request(
      ProxiesResponse,
      `/api/v1/proxies${qs({ cursor, limit: 100 })}`,
    );
    all.push(...page.data);
    if (!page.pagination.hasMore || page.pagination.nextCursor == null) break;
    cursor = page.pagination.nextCursor;
  }

  return all;
}

export function getProxy(id: number) {
  return request(ProxyDetailResponse, `/api/v1/proxies/${id}`);
}

export function getProxyOpenapi(id: number) {
  return request(ProxyOpenapiResponse, `/api/v1/proxies/${id}/openapi`);
}

export async function listAllProxyEndpoints(
  proxyId: number,
): Promise<Endpoint[]> {
  const all: Endpoint[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await request(
      EndpointsResponse,
      `/api/v1/proxies/${proxyId}/endpoints${qs({ cursor, limit: 100 })}`,
    );
    all.push(...page.data);
    if (!page.pagination.hasMore || page.pagination.nextCursor == null) break;
    cursor = page.pagination.nextCursor;
  }

  return all;
}

export { ApiError, ValidationError };
