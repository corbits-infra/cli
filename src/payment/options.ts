import type { x402PaymentRequirements as x402PaymentRequirementsV2 } from "@faremeter/types/x402v2";
import {
  formatDisplayTokenAmount,
  printFormatted,
  printJSON,
  printTable,
  printYaml,
  writeLine,
  type OutputFormat,
} from "../output/format.js";
import {
  formatPaymentOptionNetwork,
  getPaymentRequirementDetails,
} from "./requirements.js";

export type PaymentOption = {
  asset: string;
  symbol: string | null;
  amount: string;
  decimals: number | null;
  formattedAmount: string;
  network: string;
  scheme: string;
};

type PaymentOptionView = {
  asset: string;
  address: string;
  amount: string;
  network: string;
};

export type PaymentRequirementInspection = {
  version: number;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
    method?: string;
  };
  requirements: {
    scheme: string;
    network: string;
    asset: string;
    assetAddress: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown> | null;
  }[];
};

type PaymentRequirementInspectionInput = {
  detectedVersion: number;
  accepts: x402PaymentRequirementsV2[];
  resource?: PaymentRequirementInspection["resource"];
};

export function getPaymentOptions(
  accepts: x402PaymentRequirementsV2[],
): PaymentOption[] {
  return getPaymentRequirementDetails(accepts).map((detail) => ({
    asset: detail.asset,
    symbol: detail.symbol,
    amount: detail.amount,
    decimals: detail.decimals,
    formattedAmount: formatDisplayTokenAmount({
      amount: detail.amount,
      asset: detail.symbol ?? detail.asset,
      decimals: detail.decimals,
    }),
    network: detail.network,
    scheme: detail.scheme,
  }));
}

export function printPaymentOptions(
  format: OutputFormat,
  options: PaymentOption[],
): void {
  const view = options.map(
    (option): PaymentOptionView => ({
      asset: option.symbol ?? "(unknown)",
      address: option.asset,
      amount: option.formattedAmount,
      network: formatPaymentOptionNetwork(option.network),
    }),
  );

  printFormatted(
    format,
    view,
    ["Asset", "Address", "Amount", "Network"],
    (option) => [option.asset, option.address, option.amount, option.network],
  );
}

export function getPaymentRequirementInspection(
  paymentRequired: PaymentRequirementInspectionInput,
): PaymentRequirementInspection {
  return {
    version: paymentRequired.detectedVersion,
    ...(paymentRequired.resource == null
      ? {}
      : { resource: paymentRequired.resource }),
    requirements: getPaymentRequirementDetails(paymentRequired.accepts).map(
      (detail) => {
        const requirement = {
          scheme: detail.scheme,
          network: formatPaymentOptionNetwork(detail.network),
          asset: detail.symbol ?? detail.asset,
          assetAddress: detail.asset,
          amount: formatDisplayTokenAmount({
            amount: detail.amount,
            asset: detail.symbol ?? detail.asset,
            decimals: detail.decimals,
          }),
          payTo: detail.requirement.payTo,
          maxTimeoutSeconds: detail.requirement.maxTimeoutSeconds,
        };

        if (detail.requirement.extra === undefined) {
          return requirement;
        }

        return {
          ...requirement,
          extra: isRecord(detail.requirement.extra)
            ? detail.requirement.extra
            : null,
        };
      },
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function formatExtra(
  extra: Record<string, unknown> | null | undefined,
): string {
  if (extra == null) {
    return "";
  }

  return JSON.stringify(extra);
}

export function printPaymentRequirementInspection(
  format: OutputFormat,
  inspection: PaymentRequirementInspection,
): void {
  if (format === "json") {
    printJSON(inspection);
    return;
  }

  if (format === "yaml") {
    printYaml(inspection);
    return;
  }

  writeLine(`x402 Version: ${inspection.version}`);
  if (inspection.resource != null) {
    writeLine(`Resource: ${inspection.resource.url}`);
  }
  writeLine("");
  printTable(
    [
      "Scheme",
      "Network",
      "Asset",
      "Asset Address",
      "Amount",
      "Pay To",
      "Timeout",
      "Extra",
    ],
    inspection.requirements.map((requirement) => [
      requirement.scheme,
      requirement.network,
      requirement.asset,
      requirement.assetAddress,
      requirement.amount,
      requirement.payTo,
      String(requirement.maxTimeoutSeconds),
      formatExtra(requirement.extra),
    ]),
  );
}
