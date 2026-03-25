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
} from "../src/api/schemas.js";

await t.test("Proxy schema", async (t) => {
  await t.test("accepts valid proxy", async (t) => {
    const data = {
      id: 1,
      name: "helius",
      org_slug: null,
      default_price_usdc: 10000,
      default_scheme: "exact",
      tags: ["solana"],
      url: "https://helius.api.corbits.dev",
    };
    const result = Proxy(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.equal((result as typeof Proxy.infer).name, "helius");
    t.end();
  });

  await t.test("accepts proxy without org_slug", async (t) => {
    const data = {
      id: 1,
      name: "helius",
      default_price_usdc: 10000,
      default_scheme: "exact",
      tags: [],
      url: "https://helius.api.corbits.dev",
    };
    const result = Proxy(data);
    t.notOk(result instanceof type.errors, "should validate without org_slug");
    t.end();
  });

  await t.test("rejects proxy missing required fields", async (t) => {
    const data = { id: 1, name: "helius" };
    const result = Proxy(data);
    t.ok(result instanceof type.errors, "should reject incomplete data");
    t.end();
  });

  await t.test("rejects proxy with wrong types", async (t) => {
    const data = {
      id: "not-a-number",
      name: 123,
      default_price_usdc: "free",
      default_scheme: "exact",
      tags: "not-an-array",
      url: "https://example.com",
    };
    const result = Proxy(data);
    t.ok(result instanceof type.errors, "should reject wrong types");
    t.end();
  });
});

await t.test("ProxyDetail schema", async (t) => {
  await t.test("accepts valid proxy detail", async (t) => {
    const data = {
      id: 1,
      name: "helius",
      org_slug: null,
      default_price_usdc: 10000,
      default_scheme: "exact",
      tags: [],
      url: "https://helius.api.corbits.dev",
      endpoint_count: 5,
    };
    const result = ProxyDetail(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.equal((result as typeof ProxyDetail.infer).endpoint_count, 5);
    t.end();
  });

  await t.test("rejects proxy detail missing endpoint_count", async (t) => {
    const data = {
      id: 1,
      name: "helius",
      default_price_usdc: 10000,
      default_scheme: "exact",
      tags: [],
      url: "https://helius.api.corbits.dev",
    };
    const result = ProxyDetail(data);
    t.ok(result instanceof type.errors, "should reject without endpoint_count");
    t.end();
  });
});

await t.test("Endpoint schema", async (t) => {
  await t.test("accepts valid endpoint", async (t) => {
    const data = {
      id: 1,
      path_pattern: "/v1/tokens/*",
      description: "Token info",
      price_usdc: 5000,
      scheme: "exact",
      tags: ["tokens"],
    };
    const result = Endpoint(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.end();
  });

  await t.test("accepts endpoint with null optional fields", async (t) => {
    const data = {
      id: 1,
      path_pattern: "/v1/tokens/*",
      description: null,
      price_usdc: null,
      scheme: null,
      tags: [],
    };
    const result = Endpoint(data);
    t.notOk(result instanceof type.errors, "should validate with nulls");
    t.end();
  });

  await t.test("accepts endpoint without optional fields", async (t) => {
    const data = {
      id: 1,
      path_pattern: "/v1/tokens/*",
      tags: [],
    };
    const result = Endpoint(data);
    t.notOk(result instanceof type.errors, "should validate without optionals");
    t.end();
  });
});

await t.test("EndpointDetail schema", async (t) => {
  await t.test("accepts valid endpoint detail", async (t) => {
    const data = {
      id: 1,
      path_pattern: "/v1/tokens/*",
      tags: [],
      priority: 10,
      created_at: "2025-01-01T00:00:00Z",
    };
    const result = EndpointDetail(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.equal((result as typeof EndpointDetail.infer).priority, 10);
    t.end();
  });
});

await t.test("SearchEndpoint schema", async (t) => {
  await t.test("accepts valid search endpoint", async (t) => {
    const data = {
      id: 1,
      path_pattern: "/v1/tokens/*",
      tags: [],
      proxy_id: 1,
      proxy_name: "helius",
      org_slug: null,
    };
    const result = SearchEndpoint(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.equal((result as typeof SearchEndpoint.infer).proxy_name, "helius");
    t.end();
  });
});

await t.test("Pagination schema", async (t) => {
  await t.test("accepts pagination with cursor", async (t) => {
    const data = { nextCursor: "abc123", hasMore: true };
    const result = Pagination(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.end();
  });

  await t.test("accepts pagination with null cursor", async (t) => {
    const data = { nextCursor: null, hasMore: false };
    const result = Pagination(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.end();
  });
});

await t.test("SearchResponse schema", async (t) => {
  await t.test("accepts valid search response", async (t) => {
    const data = {
      proxies: [
        {
          id: 1,
          name: "helius",
          org_slug: null,
          default_price_usdc: 10000,
          default_scheme: "exact",
          tags: [],
          url: "https://helius.api.corbits.dev",
        },
      ],
      endpoints: [
        {
          id: 1,
          path_pattern: "/v1/*",
          tags: [],
          proxy_id: 1,
          proxy_name: "helius",
        },
      ],
    };
    const result = SearchResponse(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.end();
  });

  await t.test("accepts empty search response", async (t) => {
    const data = { proxies: [], endpoints: [] };
    const result = SearchResponse(data);
    t.notOk(result instanceof type.errors, "should validate empty results");
    t.end();
  });
});

await t.test("ProxiesResponse schema", async (t) => {
  await t.test("accepts valid proxies response", async (t) => {
    const data = {
      data: [
        {
          id: 1,
          name: "helius",
          default_price_usdc: 10000,
          default_scheme: "exact",
          tags: [],
          url: "https://helius.api.corbits.dev",
        },
      ],
      pagination: { nextCursor: null, hasMore: false },
    };
    const result = ProxiesResponse(data);
    t.notOk(result instanceof type.errors, "should validate");
    t.end();
  });
});
