import { command, option, optional, string, positional } from "cmd-ts";
import { search, listAllProxies } from "../api/client.js";
import type { Proxy, SearchEndpoint } from "../api/schemas.js";
import {
  formatPrice,
  printFormatted,
  printJson,
  printYaml,
} from "../output/format.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";

export const discover = command({
  name: "discover",
  description: "Search for x402-gated services",
  args: {
    query: positional({ type: optional(string), displayName: "query" }),
    tag: option({ type: optional(string), long: "tag", short: "t" }),
    format: formatFlag,
  },
  handler: async ({ query, tag, format: formatArg }) => {
    const format = resolveOutputFormat(formatArg);
    let proxies: Proxy[];
    let endpoints: SearchEndpoint[] = [];

    if (query) {
      const result = await search(query);
      proxies = result.proxies;
      endpoints = result.endpoints;
    } else {
      proxies = await listAllProxies();
    }

    if (tag) {
      const lower = tag.toLowerCase();
      proxies = proxies.filter((p) =>
        p.tags.some((t) => t.toLowerCase().includes(lower)),
      );
      endpoints = endpoints.filter((e) =>
        e.tags.some((t) => t.toLowerCase().includes(lower)),
      );
    }

    if (proxies.length === 0 && endpoints.length === 0) {
      process.stdout.write("No services found.\n");
      return;
    }

    if (format === "json") {
      printJson(query ? { proxies, endpoints } : proxies);
      return;
    }
    if (format === "yaml") {
      printYaml(query ? { proxies, endpoints } : proxies);
      return;
    }

    if (proxies.length > 0) {
      printFormatted(
        format,
        proxies,
        ["ID", "Name", "Price", "Tags", "URL"],
        (p) => [
          String(p.id),
          p.name,
          formatPrice(p.default_price),
          p.tags.join(", "),
          p.url,
        ],
      );
    }

    if (endpoints.length > 0) {
      if (proxies.length > 0) process.stdout.write("\n");
      process.stdout.write("Matching endpoints:\n");
      printFormatted(
        format,
        endpoints,
        ["Proxy", "Proxy ID", "Path", "Price", "Tags"],
        (e) => [
          e.proxy_name,
          String(e.proxy_id),
          e.path_pattern,
          e.price != null ? formatPrice(e.price) : "(default)",
          e.tags.join(", "),
        ],
      );
    }
  },
});
