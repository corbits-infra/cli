import type { ResolvedConfig } from "../config/index.js";
import {
  formatFlexRequirementMismatch,
  hasFlexRequirements,
  selectFlexRequirement,
  type FlexRequirementDetails,
} from "./flex.js";
import {
  formatPaymentRequirementMismatch,
  hasExactPaymentRequirements,
  selectExactPaymentRequirement,
  type ParsedPaymentRequiredResponse,
} from "./signer.js";
import type { PaymentRequirementDetails } from "./requirements.js";

export type PaymentAttemptMethod = "flex" | "exact";

export type PaymentAttemptIssue = {
  method: PaymentAttemptMethod;
  message: string;
};

export type PaymentAttemptResolution =
  | {
      kind: "resolved";
      attempt:
        | {
            method: "flex";
            requirement: FlexRequirementDetails;
          }
        | {
            method: "exact";
            requirement: PaymentRequirementDetails;
          };
      issues: PaymentAttemptIssue[];
    }
  | {
      kind: "unresolved";
      issues: PaymentAttemptIssue[];
    };

export function formatPaymentAttemptIssues(
  issues: readonly PaymentAttemptIssue[],
): string {
  if (issues.length === 0) {
    return "server did not provide a supported x402 payment requirement";
  }

  if (issues.length === 1) {
    return (
      issues[0]?.message ??
      "server did not provide a supported x402 payment requirement"
    );
  }

  return issues.map((issue) => `${issue.method}: ${issue.message}`).join("; ");
}

export function resolvePaymentAttempt(args: {
  challenge: ParsedPaymentRequiredResponse;
  config: ResolvedConfig;
  intent?: {
    method?: PaymentAttemptMethod;
  };
}): PaymentAttemptResolution {
  const issues: PaymentAttemptIssue[] = [];
  const flexOffered = hasFlexRequirements(args.challenge.accepts);
  const exactOffered = hasExactPaymentRequirements(args.challenge.accepts);
  const flexSelection =
    flexOffered && args.intent?.method !== "exact"
      ? selectFlexRequirement({
          accepts: args.challenge.accepts,
          config: args.config,
        })
      : undefined;
  const exactSelection =
    exactOffered && args.intent?.method !== "flex"
      ? selectExactPaymentRequirement({
          accepts: args.challenge.accepts,
          config: args.config,
        })
      : undefined;

  if (args.intent?.method === "flex" && !flexOffered) {
    return {
      kind: "unresolved",
      issues: [
        {
          method: "flex",
          message:
            "--flex-session can only be used with a Flex payment challenge",
        },
      ],
    };
  }

  if (args.intent?.method === "flex") {
    if (flexSelection?.kind === "selected") {
      return {
        kind: "resolved",
        attempt: {
          method: "flex",
          requirement: flexSelection.selected,
        },
        issues,
      };
    }

    if (flexSelection != null) {
      issues.push({
        method: "flex",
        message: formatFlexRequirementMismatch(args.config, flexSelection),
      });
    }
    return { kind: "unresolved", issues };
  }

  if (args.intent?.method === "exact") {
    if (exactSelection?.kind === "selected") {
      return {
        kind: "resolved",
        attempt: {
          method: "exact",
          requirement: exactSelection.selected,
        },
        issues,
      };
    }

    if (exactSelection != null) {
      issues.push({
        method: "exact",
        message: formatPaymentRequirementMismatch(args.config, exactSelection),
      });
    }
    return { kind: "unresolved", issues };
  }

  if (flexSelection?.kind !== "selected" && flexSelection != null) {
    issues.push({
      method: "flex",
      message: formatFlexRequirementMismatch(args.config, flexSelection),
    });
  }

  if (exactSelection?.kind !== "selected" && exactSelection != null) {
    issues.push({
      method: "exact",
      message: formatPaymentRequirementMismatch(args.config, exactSelection),
    });
  }

  if (
    flexSelection?.kind === "selected" &&
    exactSelection?.kind !== "selected"
  ) {
    return {
      kind: "resolved",
      attempt: {
        method: "flex",
        requirement: flexSelection.selected,
      },
      issues,
    };
  }

  if (
    exactSelection?.kind === "selected" &&
    flexSelection?.kind !== "selected"
  ) {
    return {
      kind: "resolved",
      attempt: {
        method: "exact",
        requirement: exactSelection.selected,
      },
      issues,
    };
  }

  if (flexSelection?.kind === "selected") {
    return {
      kind: "resolved",
      attempt: {
        method: "flex",
        requirement: flexSelection.selected,
      },
      issues,
    };
  }

  return { kind: "unresolved", issues };
}
