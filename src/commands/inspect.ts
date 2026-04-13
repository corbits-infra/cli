import { command, number, positional, flag } from "cmd-ts";
import {
  getProxy,
  listAllProxyEndpoints,
  getProxyOpenapi,
  resolveApiBaseUrl,
} from "../api/client.js";
import {
  formatPrice,
  printFormatted,
  printJson,
  printYaml,
  writeLine,
} from "../output/format.js";
import { formatFlag, resolveOutputFormat } from "../flags.js";

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
    const baseUrl = await resolveApiBaseUrl();

    if (openapi) {
      const fmt = await resolveOutputFormat(format);
      const spec = await getProxyOpenapi(proxyId, baseUrl);
      if (fmt === "json") {
        printJson(spec.data.spec);
      } else {
        printYaml(spec.data.spec);
      }
      return;
    }

    const fmt = await resolveOutputFormat(format);
    const proxy = await getProxy(proxyId, baseUrl);
    const endpoints = await listAllProxyEndpoints(proxyId, baseUrl);

    if (fmt === "json") {
      printJson({ proxy: proxy.data, endpoints });
      return;
    }
    if (fmt === "yaml") {
      printYaml({ proxy: proxy.data, endpoints });
      return;
    }

    const p = proxy.data;
    writeLine(`${p.name} (ID: ${p.id})`);
    writeLine(`  URL:       ${p.url}`);
    writeLine(`  Price:     ${formatPrice(p.default_price)}`);
    writeLine(`  Scheme:    ${p.default_scheme}`);
    writeLine(`  Tags:      ${p.tags.join(", ")}`);
    writeLine(`  Endpoints: ${p.endpoint_count}`);
    writeLine("");

    if (endpoints.length > 0) {
      printFormatted(
        fmt,
        endpoints,
        ["ID", "Path", "Price", "Scheme", "Tags"],
        (e) => [
          String(e.id),
          e.path_pattern,
          e.price != null ? formatPrice(e.price) : "(default)",
          e.scheme ?? "(default)",
          e.tags.join(", "),
        ],
      );
    }
  },
});
