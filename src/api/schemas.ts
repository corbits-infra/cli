import { type } from "arktype";

export const Proxy = type({
  id: "number",
  name: "string",
  "org_slug?": "string | null",
  default_price_usdc: "number",
  default_scheme: "string",
  tags: "string[]",
  url: "string",
});
export type Proxy = typeof Proxy.infer;

export const ProxyDetail = Proxy.and({
  endpoint_count: "number",
});
export type ProxyDetail = typeof ProxyDetail.infer;

export const Endpoint = type({
  id: "number",
  path_pattern: "string",
  "description?": "string | null",
  "price_usdc?": "number | null",
  "scheme?": "string | null",
  tags: "string[]",
});
export type Endpoint = typeof Endpoint.infer;

export const EndpointDetail = Endpoint.and({
  priority: "number",
  created_at: "string",
});
export type EndpointDetail = typeof EndpointDetail.infer;

export const SearchEndpoint = Endpoint.and({
  proxy_id: "number",
  proxy_name: "string",
  "org_slug?": "string | null",
});
export type SearchEndpoint = typeof SearchEndpoint.infer;

export const Pagination = type({
  "nextCursor?": "string | null",
  hasMore: "boolean",
});
export type Pagination = typeof Pagination.infer;

export const SearchResponse = type({
  proxies: Proxy.array(),
  endpoints: SearchEndpoint.array(),
});
export type SearchResponse = typeof SearchResponse.infer;

export const ProxiesResponse = type({
  data: Proxy.array(),
  pagination: Pagination,
});
export type ProxiesResponse = typeof ProxiesResponse.infer;

export const ProxyDetailResponse = type({
  data: ProxyDetail,
});
export type ProxyDetailResponse = typeof ProxyDetailResponse.infer;

export const EndpointsResponse = type({
  data: Endpoint.array(),
  pagination: Pagination,
});
export type EndpointsResponse = typeof EndpointsResponse.infer;

export const EndpointDetailResponse = type({
  data: EndpointDetail,
});
export type EndpointDetailResponse = typeof EndpointDetailResponse.infer;

export const ProxyOpenapiResponse = type({
  data: {
    id: "number",
    name: "string",
    spec: "Record<string, unknown>",
  },
});
export type ProxyOpenapiResponse = typeof ProxyOpenapiResponse.infer;
