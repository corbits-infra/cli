#!/usr/bin/env pnpm tsx

import t from "tap";
import { type } from "arktype";
import {
  Proxy,
  ProxyDetail,
  Endpoint,
  EndpointDetail,
  SearchEndpoint,
  Pagination,
  SearchResponse,
  ProxiesResponse,
  ProxyDetailResponse,
  EndpointsResponse,
  EndpointDetailResponse,
  ProxyOpenAPIResponse,
} from "../src/api/schemas.js";

const validProxy = {
  id: 1,
  name: "helius",
  org_slug: null,
  default_price: 10000,
  default_scheme: "exact",
  tags: ["solana"],
  url: "https://helius.api.corbits.dev",
};

const validEndpoint = {
  id: 1,
  path_pattern: "/v1/tokens/*",
  description: "Token info",
  price: 5000,
  scheme: "exact",
  tags: ["tokens"],
};

await t.test("Proxy schema", async (t) => {
  await t.test("accepts valid proxy and preserves values", async (t) => {
    const result = Proxy(validProxy);
    t.notOk(result instanceof type.errors, "should validate");
    const p = result as typeof Proxy.infer;
    t.equal(p.id, 1);
    t.equal(p.name, "helius");
    t.equal(p.default_price, 10000);
    t.equal(p.default_scheme, "exact");
    t.same(p.tags, ["solana"]);
    t.equal(p.url, "https://helius.api.corbits.dev");
    t.end();
  });

  await t.test("accepts proxy without org_slug", async (t) => {
    const { org_slug: _, ...noSlug } = validProxy;
    const result = Proxy(noSlug);
    t.notOk(result instanceof type.errors, "should validate without org_slug");
    t.end();
  });

  await t.test("rejects proxy missing required fields", async (t) => {
    t.ok(
      Proxy({ id: 1, name: "x" }) instanceof type.errors,
      "missing many fields",
    );
    t.ok(
      Proxy({ ...validProxy, tags: undefined }) instanceof type.errors,
      "missing tags",
    );
    t.end();
  });

  await t.test("rejects proxy with wrong types", async (t) => {
    t.ok(Proxy({ ...validProxy, id: "not-a-number" }) instanceof type.errors);
    t.ok(Proxy({ ...validProxy, tags: "not-an-array" }) instanceof type.errors);
    t.ok(
      Proxy({ ...validProxy, default_price: "free" }) instanceof type.errors,
    );
    t.end();
  });
});

await t.test("ProxyDetail schema", async (t) => {
  await t.test("accepts valid proxy detail with endpoint_count", async (t) => {
    const result = ProxyDetail({ ...validProxy, endpoint_count: 5 });
    t.notOk(result instanceof type.errors, "should validate");
    t.equal((result as typeof ProxyDetail.infer).endpoint_count, 5);
    t.equal((result as typeof ProxyDetail.infer).name, "helius");
    t.end();
  });

  await t.test("rejects proxy detail missing endpoint_count", async (t) => {
    t.ok(ProxyDetail(validProxy) instanceof type.errors);
    t.end();
  });
});

await t.test("Endpoint schema", async (t) => {
  await t.test("accepts valid endpoint and preserves values", async (t) => {
    const result = Endpoint(validEndpoint);
    t.notOk(result instanceof type.errors);
    const e = result as typeof Endpoint.infer;
    t.equal(e.id, 1);
    t.equal(e.path_pattern, "/v1/tokens/*");
    t.equal(e.description, "Token info");
    t.equal(e.price, 5000);
    t.same(e.tags, ["tokens"]);
    t.end();
  });

  await t.test("accepts endpoint with null optional fields", async (t) => {
    const result = Endpoint({
      id: 1,
      path_pattern: "/v1/*",
      description: null,
      price: null,
      scheme: null,
      tags: [],
    });
    t.notOk(result instanceof type.errors);
    t.end();
  });

  await t.test("accepts endpoint without optional fields", async (t) => {
    const result = Endpoint({ id: 1, path_pattern: "/v1/*", tags: [] });
    t.notOk(result instanceof type.errors);
    t.end();
  });
});

await t.test("EndpointDetail schema", async (t) => {
  await t.test("accepts and preserves detail fields", async (t) => {
    const result = EndpointDetail({
      ...validEndpoint,
      priority: 10,
      created_at: "2025-01-01T00:00:00Z",
    });
    t.notOk(result instanceof type.errors);
    const e = result as typeof EndpointDetail.infer;
    t.equal(e.priority, 10);
    t.equal(e.created_at, "2025-01-01T00:00:00Z");
    t.equal(e.path_pattern, "/v1/tokens/*");
    t.end();
  });

  await t.test("rejects without detail fields", async (t) => {
    t.ok(EndpointDetail(validEndpoint) instanceof type.errors);
    t.end();
  });
});

await t.test("SearchEndpoint schema", async (t) => {
  await t.test("accepts and preserves search fields", async (t) => {
    const result = SearchEndpoint({
      ...validEndpoint,
      proxy_id: 1,
      proxy_name: "helius",
      org_slug: null,
    });
    t.notOk(result instanceof type.errors);
    const e = result as typeof SearchEndpoint.infer;
    t.equal(e.proxy_id, 1);
    t.equal(e.proxy_name, "helius");
    t.equal(e.path_pattern, "/v1/tokens/*");
    t.end();
  });

  await t.test("rejects without proxy_id", async (t) => {
    t.ok(
      SearchEndpoint({ ...validEndpoint, proxy_name: "x" }) instanceof
        type.errors,
    );
    t.end();
  });
});

await t.test("Pagination schema", async (t) => {
  await t.test("accepts and preserves cursor", async (t) => {
    const result = Pagination({ nextCursor: "abc123", hasMore: true });
    t.notOk(result instanceof type.errors);
    const p = result as typeof Pagination.infer;
    t.equal(p.nextCursor, "abc123");
    t.equal(p.hasMore, true);
    t.end();
  });

  await t.test("accepts null cursor", async (t) => {
    const result = Pagination({ nextCursor: null, hasMore: false });
    t.notOk(result instanceof type.errors);
    t.equal((result as typeof Pagination.infer).hasMore, false);
    t.end();
  });

  await t.test("rejects missing hasMore", async (t) => {
    t.ok(Pagination({ nextCursor: "abc" }) instanceof type.errors);
    t.end();
  });
});

await t.test("SearchResponse schema", async (t) => {
  await t.test("accepts valid response with data", async (t) => {
    const result = SearchResponse({
      proxies: [validProxy],
      endpoints: [{ ...validEndpoint, proxy_id: 1, proxy_name: "helius" }],
    });
    t.notOk(result instanceof type.errors);
    const r = result as typeof SearchResponse.infer;
    t.equal(r.proxies.length, 1);
    t.equal(r.endpoints.length, 1);
    t.equal(r.proxies[0]?.name, "helius");
    t.end();
  });

  await t.test("accepts empty arrays", async (t) => {
    const result = SearchResponse({ proxies: [], endpoints: [] });
    t.notOk(result instanceof type.errors);
    t.end();
  });

  await t.test("rejects invalid nested proxy", async (t) => {
    const result = SearchResponse({
      proxies: [{ id: "bad" }],
      endpoints: [],
    });
    t.ok(result instanceof type.errors);
    t.end();
  });
});

await t.test("ProxiesResponse schema", async (t) => {
  await t.test("accepts valid paginated response", async (t) => {
    const result = ProxiesResponse({
      data: [validProxy],
      pagination: { nextCursor: "abc", hasMore: true },
    });
    t.notOk(result instanceof type.errors);
    const r = result as typeof ProxiesResponse.infer;
    t.equal(r.data.length, 1);
    t.equal(r.pagination.hasMore, true);
    t.equal(r.pagination.nextCursor, "abc");
    t.end();
  });
});

await t.test("ProxyDetailResponse schema", async (t) => {
  await t.test("accepts valid response", async (t) => {
    const result = ProxyDetailResponse({
      data: { ...validProxy, endpoint_count: 3 },
    });
    t.notOk(result instanceof type.errors);
    t.equal(
      (result as typeof ProxyDetailResponse.infer).data.endpoint_count,
      3,
    );
    t.end();
  });

  await t.test("rejects when missing endpoint_count", async (t) => {
    t.ok(ProxyDetailResponse({ data: validProxy }) instanceof type.errors);
    t.end();
  });
});

await t.test("EndpointsResponse schema", async (t) => {
  await t.test("accepts valid paginated response", async (t) => {
    const result = EndpointsResponse({
      data: [validEndpoint],
      pagination: { nextCursor: null, hasMore: false },
    });
    t.notOk(result instanceof type.errors);
    const r = result as typeof EndpointsResponse.infer;
    t.equal(r.data.length, 1);
    t.equal(r.data[0]?.path_pattern, "/v1/tokens/*");
    t.end();
  });
});

await t.test("EndpointDetailResponse schema", async (t) => {
  await t.test("accepts valid response", async (t) => {
    const result = EndpointDetailResponse({
      data: {
        ...validEndpoint,
        priority: 5,
        created_at: "2025-06-01T00:00:00Z",
      },
    });
    t.notOk(result instanceof type.errors);
    t.equal((result as typeof EndpointDetailResponse.infer).data.priority, 5);
    t.end();
  });
});

await t.test("ProxyOpenAPIResponse schema", async (t) => {
  await t.test("accepts valid response with object spec", async (t) => {
    const result = ProxyOpenAPIResponse({
      data: {
        id: 1,
        name: "helius",
        spec: { openapi: "3.0.0", paths: {} },
      },
    });
    t.notOk(result instanceof type.errors);
    t.end();
  });

  await t.test("rejects non-object spec", async (t) => {
    const result = ProxyOpenAPIResponse({
      data: { id: 1, name: "helius", spec: "not an object" },
    });
    t.ok(result instanceof type.errors, "strings should not be valid specs");
    t.end();
  });
});
