import { command, number, positional, flag } from "cmd-ts";
import {
  getProxy,
  listAllProxyEndpoints,
  getProxyOpenapi,
} from "../api/client.js";
import {
  formatPrice,
  printFormatted,
  printJson,
  printYaml,
} from "../output/format.js";
import { formatFlag } from "../flags.js";

const stdout = (s: string) => process.stdout.write(s + "\n");

export const inspect = command({
  name: "inspect",
  description: "Inspect a proxy and its endpoints",
  args: {
    proxyId: positional({ type: number, displayName: "proxy-id" }),
    openapi: flag({
      long: "openapi",
      description: "Show upstream OpenAPI spec",
    }),
    format: formatFlag,
  },
  handler: async ({ proxyId, openapi, format }) => {
    const fmt = format ?? "table";
    const proxy = await getProxy(proxyId);
    const endpoints = await listAllProxyEndpoints(proxyId);

    if (openapi) {
      const spec = await getProxyOpenapi(proxyId);
      if (fmt === "json") {
        printJson(spec.data.spec);
      } else {
        printYaml(spec.data.spec);
      }
      return;
    }

    if (fmt === "json") {
      printJson({ proxy: proxy.data, endpoints });
      return;
    }
    if (fmt === "yaml") {
      printYaml({ proxy: proxy.data, endpoints });
      return;
    }

    const p = proxy.data;
    stdout(`${p.name} (ID: ${p.id})`);
    stdout(`  URL:       ${p.url}`);
    stdout(`  Price:     ${formatPrice(p.default_price_usdc)}`);
    stdout(`  Scheme:    ${p.default_scheme}`);
    stdout(`  Tags:      ${p.tags.join(", ")}`);
    stdout(`  Endpoints: ${p.endpoint_count}`);
    stdout("");

    if (endpoints.length > 0) {
      printFormatted(
        fmt,
        endpoints,
        ["ID", "Path", "Price", "Scheme", "Tags"],
        (e) => [
          String(e.id),
          e.path_pattern,
          e.price_usdc != null ? formatPrice(e.price_usdc) : "(default)",
          e.scheme ?? "(default)",
          e.tags.join(", "),
        ],
      );
    }
  },
});
