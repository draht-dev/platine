// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/sst/plan — pure provisioning-plan derivation.
 *
 * planResources() is a PURE function: it reads the Manifest and DrahtAgentProps
 * and returns a plain-object description of WHAT to provision.  The Agent()
 * factory then instantiates sst.aws.* from this plan.
 *
 * This separation makes the provisioning DECISIONS unit-testable without Pulumi.
 * No aws/sst globals are accessed here — this file must typecheck in isolation.
 */

import type { Manifest } from "@draht/manifest";
import type { DrahtAgentProps } from "./types.js";

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

/** A single cron schedule entry derived from a `schedule` trigger. */
export interface CronEntry {
  readonly triggerId: string;
  /** AWS EventBridge rate/cron expression derived from the manifest cron field. */
  readonly schedule: string;
}

/** A single HTTP route derived from a `http` channel. */
export interface HttpRoute {
  readonly channelId: string;
  readonly path: string;
  readonly auth: string | undefined;
  /**
   * When true the consumer supplied a router in props.channels; the factory
   * should attach to it with route(path, handler).
   * When false the factory should create a Function URL (url: true).
   */
  readonly useRouter: boolean;
}

/** An IAM permission that should be granted to the executor Function. */
export interface IamPermission {
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

/** A secret that should be injected as an environment variable. */
export interface SecretLink {
  readonly envName: string;
  readonly from: "sst-secret" | "ssm";
  readonly key: string;
}

/** Full plain-object provisioning plan returned by planResources(). */
export interface ResourcePlan {
  /** Whether to create a DLQ alongside the main queue. Always true. */
  readonly createDlq: boolean;
  /** Whether to create a CloudWatch MetricAlarm on the DLQ. Always true. */
  readonly createDlqAlarm: boolean;
  /**
   * SQS visibility timeout in seconds.
   * MUST be strictly greater than the Lambda timeout.
   * Computed as (timeoutSeconds + 60) rounded to the next SQS-valid value.
   */
  readonly visibilityTimeoutSeconds: number;
  /** Lambda executor timeout in seconds (≤ 900). */
  readonly timeoutSeconds: number;
  /** Lambda executor memory in MB. */
  readonly memoryMB: number;
  /**
   * Storage mode.
   * "managed" — own DynamoDB table, removal:'retain' + deletionProtection.
   * "shared"  — host-supplied table; a hard DRAHT#<name># key namespace is applied.
   */
  readonly storageMode: "managed" | "shared";
  /**
   * When storageMode === "shared", the pk namespace prefix.
   * Format: "DRAHT#<agentName>#".
   * Guaranteed to be non-empty when storageMode === "shared".
   */
  readonly sharedTableNamespace: string;
  /** Whether to create an own EventBridge bus (false = reuse host bus from props.bus). */
  readonly createBus: boolean;
  /** Cron schedules to provision (one sst.aws.Cron per entry). */
  readonly cronSchedules: readonly CronEntry[];
  /** HTTP routes to attach (one route handler per entry). */
  readonly httpRoutes: readonly HttpRoute[];
  /**
   * Bedrock IAM permission block.
   * Present when manifest.resources.needsBedrock === true
   * OR when props.model.provider === "bedrock".
   */
  readonly bedrockPermission: IamPermission | null;
  /**
   * Extra IAM permissions from manifest.resources.extraIam merged with
   * props.permissions (if any).
   */
  readonly extraPermissions: readonly IamPermission[];
  /** Secrets to link into the executor function. */
  readonly secrets: readonly SecretLink[];
  /** The full manifest blob serialised to JSON (for snapshotting into DynamoDB). */
  readonly manifestBlob: string;
  /** The manifest agentId. */
  readonly manifestId: string;
  /** The manifest revision. */
  readonly manifestRevision: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `"14 minutes"` → 840, `"5 minutes"` → 300, default 840. */
function parseTimeoutSeconds(timeout: `${number} minutes` | undefined): number {
  if (timeout === undefined) return 840; // default 14 minutes
  const [numStr] = timeout.split(" ");
  const n = Number(numStr);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 60), 900) : 840;
}

/** Parse `"1024 MB"` → 1024, default 1024. */
function parseMemoryMB(memory: `${number} MB` | undefined): number {
  if (memory === undefined) return 1024;
  const [numStr] = memory.split(" ");
  const n = Number(numStr);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1024;
}

/**
 * Derive the SQS visibility timeout.
 * Must be STRICTLY greater than the Lambda timeout (Appendix A.2 must-fix).
 * SQS max is 43200 s (12 h); we add 60 s buffer over the Lambda timeout.
 */
function computeVisibilityTimeout(timeoutSeconds: number): number {
  return Math.min(timeoutSeconds + 60, 43200);
}

/**
 * Convert a portable cron expression from the manifest into an AWS
 * EventBridge schedule expression.
 *
 * The manifest `cron` field is a standard 5-field POSIX cron (min hour dom mon dow).
 * EventBridge accepts `rate(...)` or `cron(min hour dom mon dow year)`.
 * We simply wrap it: `cron(<expr> *)` where `*` is the year field.
 */
function toAwsScheduleExpression(cron: string): string {
  // If already an aws expression pass through unchanged.
  if (cron.startsWith("rate(") || cron.startsWith("cron(")) {
    return cron;
  }
  // Wrap as EventBridge cron with wildcard year.
  return `cron(${cron} *)`;
}

// ---------------------------------------------------------------------------
// planResources — the only public export
// ---------------------------------------------------------------------------

/**
 * Derive a plain-object provisioning plan from a parsed Manifest and DrahtAgentProps.
 *
 * This function is PURE — it reads no globals, performs no I/O, and can be called
 * in unit tests without Pulumi or AWS.
 *
 * @param manifest  The fully-parsed Manifest (from parseManifest()).
 * @param props     The DrahtAgentProps passed by the consumer.
 * @returns         A ResourcePlan describing exactly what resources to provision.
 */
export function planResources(
  manifest: Manifest,
  props: DrahtAgentProps
): ResourcePlan {
  // ── timeouts ────────────────────────────────────────────────────────────
  const timeoutSeconds = parseTimeoutSeconds(props.timeout);
  const memoryMB = parseMemoryMB(props.memory);
  const visibilityTimeoutSeconds = computeVisibilityTimeout(timeoutSeconds);

  // ── storage mode ─────────────────────────────────────────────────────────
  const storageMode: "managed" | "shared" =
    props.storage?.mode === "shared" ? "shared" : "managed";

  const sharedTableNamespace: string =
    storageMode === "shared"
      ? `DRAHT#${manifest.agent.agentId}#`
      : "";

  // ── bus ──────────────────────────────────────────────────────────────────
  // Create own bus only when no host bus is injected via props.bus.
  const createBus: boolean = props.bus === undefined;

  // ── cron schedules (one per schedule trigger) ────────────────────────────
  const cronSchedules: CronEntry[] = manifest.triggers
    .filter((t): t is typeof t & { type: "schedule" } => t.type === "schedule")
    .map((t) => ({
      triggerId: `${manifest.agent.agentId}-${t.schedule}`,
      schedule: toAwsScheduleExpression(t.cron),
    }));

  // ── HTTP routes ───────────────────────────────────────────────────────────
  // Prefer http channels declared in the manifest (authoring-time). When the
  // manifest declares none, derive routes from deploy-time props.channels — the
  // SST-layer channel config (per §3.4 DrahtAgentProps.channels). This lets an
  // agent whose workflow uses a non-http trigger still expose an HTTP ingress
  // purely from the sst.config.ts.
  const manifestHttp = manifest.channels.filter((ch) => ch.kind === "http");
  let httpRoutes: HttpRoute[];
  if (manifestHttp.length > 0) {
    httpRoutes = manifestHttp.map((ch) => {
      const channelCfg = props.channels?.find((c) => c.kind === "http");
      const useRouter =
        channelCfg !== undefined && "router" in channelCfg && channelCfg.router !== undefined;
      return { channelId: ch.channelId, path: ch.path ?? "/", auth: ch.auth, useRouter };
    });
  } else {
    httpRoutes = (props.channels ?? [])
      .filter((c) => c.kind === "http")
      .map((cfg, i) => {
        const path = "path" in cfg && cfg.path !== undefined ? cfg.path : "/";
        const useRouter = "router" in cfg && cfg.router !== undefined;
        return { channelId: i === 0 ? "http" : `http${i}`, path, auth: undefined, useRouter };
      });
  }

  // ── IAM permissions ───────────────────────────────────────────────────────
  // Bedrock permission: required when manifest says needsBedrock OR model provider is bedrock.
  const needsBedrock =
    manifest.resources.needsBedrock === true ||
    props.model.provider === "bedrock";

  const bedrockPermission: IamPermission | null = needsBedrock
    ? {
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
      }
    : null;

  // Extra permissions: merge manifest.resources.extraIam + props.permissions.
  const extraPermissions: IamPermission[] = [
    ...manifest.resources.extraIam.map((e) => ({
      actions: e.actions,
      resources: e.resources,
    })),
    ...(props.permissions ?? []),
  ];

  // ── secrets ───────────────────────────────────────────────────────────────
  const secrets: SecretLink[] = manifest.resources.secrets.map((s) => ({
    envName: s.name,
    from: s.from,
    key: s.key,
  }));

  // ── manifest snapshot ─────────────────────────────────────────────────────
  const manifestBlob = JSON.stringify(manifest);

  return {
    createDlq: true,
    createDlqAlarm: true,
    visibilityTimeoutSeconds,
    timeoutSeconds,
    memoryMB,
    storageMode,
    sharedTableNamespace,
    createBus,
    cronSchedules,
    httpRoutes,
    bedrockPermission,
    extraPermissions,
    secrets,
    manifestBlob,
    manifestId: manifest.agent.agentId,
    manifestRevision: manifest.revision,
  };
}
