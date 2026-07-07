// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/sst/types — public prop types for the draht SST factory.
 *
 * These types are exported from the package root so consumers can type their
 * own wrapper without importing from the ambient-global-polluted factory file.
 *
 * ZERO top-level @pulumi/* or @sst/platform imports — everything SST/Pulumi
 * specific is typed as `unknown` (resolved at consumer typecheck via the
 * platform's own config.d.ts ambient injections).
 */

import type { Manifest } from "@draht/manifest";

/**
 * Props for draht.Agent() and draht.Workflow().
 *
 * All sst.* / aws.* values are typed as `unknown` so this file typechecks
 * without the SST platform present.  At runtime (inside the SST run() fn)
 * the actual sst.aws.Queue, sst.aws.Router, etc. are passed and used correctly.
 */
export interface DrahtAgentProps {
  /**
   * Inline parsed Manifest object OR a path to a `platine build` JSON file.
   * When a string is provided it is read synchronously at Pulumi-program time
   * (inside the Agent() factory, before any resource is declared).
   */
  manifest: Manifest | string;

  /** Model configuration. */
  model: {
    provider: "anthropic" | "bedrock";
    /** sst.Secret for the Anthropic API key (ignored when provider=bedrock). */
    apiKey?: unknown;
    /** Default model ID (e.g. "eu.anthropic.claude-haiku-4-5"). */
    defaultModel: string;
    /** Optional fallback model IDs. */
    fallbacks?: string[];
  };

  /**
   * Storage configuration.
   *
   * "managed" (default) — own DynamoDB table, removal:'retain' + deletionProtection.
   * "shared" — opt-in, HIGH RISK.  The consumer supplies an existing sst.aws.Dynamo
   * resource.  draht hard-namespaces all keys with "DRAHT#<agentId>#".
   */
  storage?:
    | { mode: "managed"; retain?: boolean }
    | {
        mode: "shared";
        /** The host sst.aws.Dynamo table resource (typed as unknown to avoid platform imports). */
        table: unknown;
        keyPrefix?: string;
      };

  /**
   * Reuse a host EventBridge Bus.  When omitted draht creates its own bus.
   * Typed as unknown to avoid @sst/platform imports.
   */
  bus?: unknown;

  /**
   * HTTP channel configs.  One entry per `http` channel in the manifest.
   * When `router` is provided the factory attaches via router.route(); otherwise
   * a Lambda Function URL (url: true) is created as a fallback.
   */
  channels?: Array<{
    kind: "http";
    /** Optional sst.aws.Router to attach the channel route to. */
    router?: unknown;
    /** Path override (defaults to the manifest channel path). */
    path?: string;
    cors?: boolean;
    /**
     * Auth scheme for this ingress channel (e.g. "bearer", "aws_iam").
     * SECURITY FIX (HIGH 5): when absent the ingress endpoint is PUBLIC.
     * The factory will emit a console.warn so the deployer is aware.
     */
    auth?: string;
  }>;

  /** Tenancy mode.  "multi" is a seam only — single-tenant default in v1. */
  tenancy?: { mode: "single" } | { mode: "multi"; resolveTenant: string };

  /**
   * AWS provider override (cloud-agnostic seam).
   * Typed as unknown to avoid @pulumi/aws imports.
   */
  provider?: unknown;

  /**
   * Additional SST/Pulumi resources to link into the executor Function
   * (forwarded to Function `link` prop).
   */
  link?: unknown[];

  /**
   * Additional IAM permissions to grant to the executor Function.
   * Merged with permissions derived from the manifest.
   */
  permissions?: Array<{
    actions: string[];
    resources: string[];
  }>;

  /**
   * Additional environment variables to inject into all Lambda functions.
   */
  environment?: Record<string, string>;

  /**
   * Lambda executor timeout.  Set near 15 min so the soft-budget math holds.
   * SQS visibility timeout is computed as (timeout + 60s) to ensure it is
   * STRICTLY greater (Appendix A.2 must-fix).
   * @default "14 minutes"
   */
  timeout?: `${number} minutes`;

  /**
   * Lambda executor memory.
   * @default "1024 MB"
   */
  memory?: `${number} MB`;

  /**
   * Path to a per-agent generated executor entry file (`.platine/executor.entry.ts`,
   * produced by `platine build`), resolved relative to the SST run cwd.
   *
   * When set, the executor Lambda's handler is built from THIS file (statically
   * importing the user's workflow.ts + `makeExecutorHandler` from
   * `@draht/runtime-aws`) instead of the shared `@draht/runtime-aws/handlers`
   * package entry. Only the executor Function switches — cron/ingress/resume
   * handlers always use the shared package module.
   */
  entry?: string;
}

/**
 * The value returned by draht.Agent() / draht.Workflow().
 *
 * All resource references are typed as unknown here; consumers that need the
 * precise types (sst.aws.Queue etc.) can assert after calling the factory.
 */
export interface DrahtAgentOutput {
  /** SQS main queue URL (Pulumi Output<string>). */
  queueUrl: unknown;
  /** HTTP endpoint URL, or undefined when no http channel is configured. */
  httpUrl: unknown;
  /**
   * Approval-resume Function URL (IAM-authenticated, `aws_iam` auth).
   * Consumers sign requests with SigV4 (e.g. `platine runs approve` or the
   * conformance harness) to POST { runId, actionId, decision } and resume a
   * held run.
   */
  resumeUrl: unknown;
  /** EventBridge bus name (Pulumi Output<string>). */
  busName: unknown;
  /** DynamoDB table name (Pulumi Output<string>). */
  tableName: unknown;
  /** The manifest revision string baked into the deployment. */
  manifestRevision: string;
  /**
   * Returns the sst.Linkable getSSTLink() value.
   * Consumers pass this to `link: [drahtAgent]` in their other SST components.
   */
  getSSTLink: () => unknown;
}
