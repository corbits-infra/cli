import type { ResolvedConfig } from "../config/index.js";
import { buildPayer } from "./payer.js";

export type RetryHeader = {
  name: string;
  value: string;
};

type BuildPaymentRetryHeaderArgs = {
  config: ResolvedConfig;
  response: Response;
  url: string;
  requestInit: RequestInit;
};

type BuildPaymentRetryHeaderDeps = {
  buildPayer: typeof buildPayer;
};

export function createBuildPaymentRetryHeader(
  deps: BuildPaymentRetryHeaderDeps,
) {
  return async function buildPaymentRetryHeader(
    args: BuildPaymentRetryHeaderArgs,
  ): Promise<RetryHeader> {
    let xPaymentHeader: string | null = null;
    const payer = await deps.buildPayer(args.config, {
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        const v1Header = headers.get("X-PAYMENT");
        if (v1Header != null) {
          xPaymentHeader = v1Header;
        }

        return new Response("", { status: 200, statusText: "OK" });
      },
      options: {
        fetch: {
          handlers: [],
          phase1Fetch: async () => args.response.clone(),
        },
      },
    });

    await payer.fetch(args.url, args.requestInit);

    if (xPaymentHeader != null) {
      return { name: "X-PAYMENT", value: xPaymentHeader };
    }

    throw new Error("failed to generate payment retry header");
  };
}

export const buildPaymentRetryHeader = createBuildPaymentRetryHeader({
  buildPayer,
});
