// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/sst — planResources() unit tests.
 *
 * planResources() is a PURE function: no Pulumi globals, no AWS SDK, no I/O.
 * Feed it a parsed Manifest and DrahtAgentProps, assert the ResourcePlan shape.
 *
 * The §3.1 "support-triage" manifest (HTTP-in → classify agent → approval-gated
 * escalate tool, model.provider=bedrock) is used as the canonical fixture.
 */

import { describe, it, expect } from "vitest";
import { parseManifest } from "@draht/manifest";
import { planResources } from "./plan.js";
import type { DrahtAgentProps } from "./types.js";

// ---------------------------------------------------------------------------
// §3.1 support-triage manifest fixture
// ---------------------------------------------------------------------------

const SUPPORT_TRIAGE_RAW = {
  schemaVersion: "1.0.0",
  revision: "rev_a3f91c08b7",
  kind: "workflow",
  agent: {
    agentId: "support-triage",
    name: "Support Triage",
    model: { provider: "bedrock", modelId: "eu.anthropic.claude-haiku-4-5" },
    instructionsRef: { contentHash: "sha256:9f2a", inline: "You triage support tickets..." },
    maxIterations: 5,
    maxToolCallsPerIteration: 3,
    circuitBreakerErrorThreshold: 5,
  },
  tenancy: { mode: "single" },
  triggers: [
    {
      type: "event",
      eventType: "ticket.created",
      filters: [{ field: "priority", operator: "eq", value: "high" }],
    },
  ],
  channels: [
    { channelId: "http-in", kind: "http", path: "/v1/triage", auth: "bearer" },
  ],
  tools: [
    {
      toolId: "escalate_ticket",
      name: "Escalate Ticket",
      description: "Escalate to human queue",
      kind: "local",
      requiresApproval: true,
      dangerous: true,
      requiresPermission: "app:edit",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ticketId", "reason"],
      },
    },
  ],
  nodes: [
    {
      nodeId: "classify",
      kind: "agent",
      agentRef: "support-triage",
      outputSchema: [
        { path: "classification", type: "string", isTemplatable: true },
        { path: "ticketId", type: "string", isTemplatable: true },
      ],
    },
    {
      nodeId: "escalate",
      kind: "tool",
      toolRef: "escalate_ticket",
      requiresApproval: true,
      params: { ticketId: "{{ticketId}}", reason: "{{classification}}" },
      outputSchema: [{ path: "queued", type: "boolean", isTemplatable: true }],
    },
  ],
  edges: [{ edgeId: "e1", source: "classify", target: "escalate" }],
  resources: {
    needsBedrock: true,
    needsEventBus: true,
    secrets: [{ name: "ESCALATION_API_KEY", from: "sst-secret", key: "EscalationApiKey" }],
  },
  resume: { via: "api", holdsApproval: true },
} as const;

// ---------------------------------------------------------------------------
// Manifest with schedule triggers
// ---------------------------------------------------------------------------

const SCHEDULE_MANIFEST_RAW = {
  schemaVersion: "1.0.0",
  revision: "rev_schedule001",
  kind: "agent",
  agent: {
    agentId: "daily-report",
    name: "Daily Report",
    model: { provider: "anthropic", modelId: "claude-3-5-haiku-20241022" },
    instructionsRef: { contentHash: "sha256:aabb" },
    maxIterations: 3,
    maxToolCallsPerIteration: 2,
    circuitBreakerErrorThreshold: 5,
  },
  tenancy: { mode: "single" },
  triggers: [
    {
      type: "schedule",
      schedule: "daily",
      time: "09:00",
      cron: "0 9 * * *",
    },
    {
      type: "schedule",
      schedule: "weekly",
      dayOfWeek: 1,
      cron: "0 8 * * 1",
    },
  ],
  channels: [],
  resources: {
    needsBedrock: false,
    needsEventBus: true,
    secrets: [],
  },
  resume: { via: "api", holdsApproval: false },
} as const;

// ---------------------------------------------------------------------------
// Helper to build a minimal valid DrahtAgentProps
// ---------------------------------------------------------------------------

function minimalProps(
  overrides: Partial<DrahtAgentProps> = {}
): DrahtAgentProps {
  const base: DrahtAgentProps = {
    manifest: parseManifest(SUPPORT_TRIAGE_RAW),
    model: { provider: "bedrock", defaultModel: "eu.anthropic.claude-haiku-4-5" },
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planResources — support-triage fixture", () => {
  const manifest = parseManifest(SUPPORT_TRIAGE_RAW);
  const props = minimalProps();
  const plan = planResources(manifest, props);

  it("always creates a DLQ", () => {
    expect(plan.createDlq).toBe(true);
  });

  it("always creates a DLQ alarm", () => {
    expect(plan.createDlqAlarm).toBe(true);
  });

  it("visibilityTimeout is strictly greater than Lambda timeout", () => {
    expect(plan.visibilityTimeoutSeconds).toBeGreaterThan(plan.timeoutSeconds);
  });

  it("default timeout is 840 seconds (14 minutes)", () => {
    expect(plan.timeoutSeconds).toBe(840);
  });

  it("default visibilityTimeout = timeout + 60", () => {
    expect(plan.visibilityTimeoutSeconds).toBe(plan.timeoutSeconds + 60);
  });

  it("default storageMode is managed", () => {
    expect(plan.storageMode).toBe("managed");
  });

  it("managed mode has empty sharedTableNamespace", () => {
    expect(plan.sharedTableNamespace).toBe("");
  });

  it("no host bus supplied → createBus is true", () => {
    expect(plan.createBus).toBe(true);
  });

  it("host bus supplied → createBus is false", () => {
    const p = minimalProps({ bus: { name: "my-bus" } });
    const pl = planResources(manifest, p);
    expect(pl.createBus).toBe(false);
  });

  it("produces a bedrock IAM permission because model.provider=bedrock", () => {
    expect(plan.bedrockPermission).not.toBeNull();
    expect(plan.bedrockPermission?.actions).toContain("bedrock:InvokeModel");
    expect(plan.bedrockPermission?.actions).toContain("bedrock:InvokeModelWithResponseStream");
  });

  it("produces a bedrock IAM permission when manifest.resources.needsBedrock is true", () => {
    // Even if props.model.provider=anthropic but manifest says needsBedrock
    const p = minimalProps({ model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" } });
    const pl = planResources(manifest, p);
    expect(pl.bedrockPermission).not.toBeNull();
  });

  it("produces one http route for the http channel", () => {
    expect(plan.httpRoutes).toHaveLength(1);
    const route = plan.httpRoutes[0];
    expect(route).toBeDefined();
    if (route !== undefined) {
      expect(route.channelId).toBe("http-in");
      expect(route.path).toBe("/v1/triage");
      expect(route.auth).toBe("bearer");
    }
  });

  it("http route uses Function URL (url:true) when no router supplied", () => {
    const route = plan.httpRoutes[0];
    expect(route).toBeDefined();
    if (route !== undefined) {
      expect(route.useRouter).toBe(false);
    }
  });

  it("http route uses router when router supplied in props.channels", () => {
    const p = minimalProps({
      channels: [{ kind: "http", router: { url: "https://example.com" }, path: "/v1/triage" }],
    });
    const pl = planResources(manifest, p);
    const route = pl.httpRoutes[0];
    expect(route).toBeDefined();
    if (route !== undefined) {
      expect(route.useRouter).toBe(true);
    }
  });

  it("no schedule triggers → no cron schedules", () => {
    // support-triage has event trigger, not schedule
    expect(plan.cronSchedules).toHaveLength(0);
  });

  it("secrets are extracted from the manifest", () => {
    expect(plan.secrets).toHaveLength(1);
    const secret = plan.secrets[0];
    expect(secret).toBeDefined();
    if (secret !== undefined) {
      expect(secret.envName).toBe("ESCALATION_API_KEY");
      expect(secret.from).toBe("sst-secret");
      expect(secret.key).toBe("EscalationApiKey");
    }
  });

  it("manifestBlob is a non-empty JSON string", () => {
    expect(typeof plan.manifestBlob).toBe("string");
    expect(plan.manifestBlob.length).toBeGreaterThan(0);
    // Should be parseable JSON
    expect(() => JSON.parse(plan.manifestBlob)).not.toThrow();
  });

  it("manifestId = manifest.agent.agentId", () => {
    expect(plan.manifestId).toBe("support-triage");
  });

  it("manifestRevision matches manifest.revision", () => {
    expect(plan.manifestRevision).toBe(manifest.revision);
  });

  it("default memory is 1024 MB", () => {
    expect(plan.memoryMB).toBe(1024);
  });
});

describe("planResources — timeout and visibility timeout math", () => {
  const manifest = parseManifest(SUPPORT_TRIAGE_RAW);

  it("custom timeout is parsed correctly", () => {
    const p = minimalProps({ timeout: "5 minutes" });
    const plan = planResources(manifest, p);
    expect(plan.timeoutSeconds).toBe(300);
  });

  it("visibilityTimeout is always > timeout for any valid timeout", () => {
    for (const t of ["1 minutes", "5 minutes", "10 minutes", "14 minutes", "15 minutes"] as const) {
      const p = minimalProps({ timeout: t });
      const plan = planResources(manifest, p);
      expect(plan.visibilityTimeoutSeconds).toBeGreaterThan(
        plan.timeoutSeconds,
        // message for debugging
      );
    }
  });

  it("timeout is capped at 900 seconds", () => {
    // 15 minutes = 900 s, which is max Lambda timeout
    const p = minimalProps({ timeout: "15 minutes" });
    const plan = planResources(manifest, p);
    expect(plan.timeoutSeconds).toBe(900);
  });

  it("custom memory is parsed correctly", () => {
    const p = minimalProps({ memory: "2048 MB" });
    const plan = planResources(manifest, p);
    expect(plan.memoryMB).toBe(2048);
  });
});

describe("planResources — shared table mode", () => {
  const manifest = parseManifest(SUPPORT_TRIAGE_RAW);

  it("shared mode sets storageMode to shared", () => {
    const p = minimalProps({
      storage: { mode: "shared", table: { name: "fr3n-main-table" } },
    });
    const plan = planResources(manifest, p);
    expect(plan.storageMode).toBe("shared");
  });

  it("shared mode sets the namespace to DRAHT#<agentId>#", () => {
    const p = minimalProps({
      storage: { mode: "shared", table: { name: "fr3n-main-table" } },
    });
    const plan = planResources(manifest, p);
    expect(plan.sharedTableNamespace).toBe("DRAHT#support-triage#");
  });

  it("shared mode namespace is non-empty", () => {
    const p = minimalProps({
      storage: { mode: "shared", table: { name: "fr3n-main-table" } },
    });
    const plan = planResources(manifest, p);
    expect(plan.sharedTableNamespace.length).toBeGreaterThan(0);
  });

  it("managed mode namespace is empty string", () => {
    const plan = planResources(manifest, minimalProps());
    expect(plan.sharedTableNamespace).toBe("");
  });
});

describe("planResources — schedule triggers → cron entries", () => {
  const manifest = parseManifest(SCHEDULE_MANIFEST_RAW);

  it("two schedule triggers produce two cron entries", () => {
    const plan = planResources(manifest, {
      manifest,
      model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" },
    });
    expect(plan.cronSchedules).toHaveLength(2);
  });

  it("cron schedule expression is wrapped in cron(...) for EventBridge", () => {
    const plan = planResources(manifest, {
      manifest,
      model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" },
    });
    for (const entry of plan.cronSchedules) {
      // Should be either rate(...) or cron(...)
      expect(entry.schedule).toMatch(/^(rate|cron)\(/);
    }
  });

  it("daily cron gets a cron() expression", () => {
    const plan = planResources(manifest, {
      manifest,
      model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" },
    });
    const daily = plan.cronSchedules.find((c) => c.triggerId.includes("daily"));
    expect(daily).toBeDefined();
    if (daily !== undefined) {
      expect(daily.schedule).toBe("cron(0 9 * * * *)");
    }
  });

  it("anthropic provider → no bedrock IAM permission", () => {
    const plan = planResources(manifest, {
      manifest,
      model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" },
    });
    expect(plan.bedrockPermission).toBeNull();
  });

  it("no http channels → no http routes", () => {
    const plan = planResources(manifest, {
      manifest,
      model: { provider: "anthropic", defaultModel: "claude-3-5-haiku" },
    });
    expect(plan.httpRoutes).toHaveLength(0);
  });
});

describe("planResources — extra IAM permissions", () => {
  const manifest = parseManifest(SUPPORT_TRIAGE_RAW);

  it("extraIam from manifest is forwarded to plan", () => {
    // Build a manifest with extraIam
    const withExtraIam = {
      ...SUPPORT_TRIAGE_RAW,
      resources: {
        ...SUPPORT_TRIAGE_RAW.resources,
        extraIam: [
          { actions: ["s3:GetObject"], resources: ["arn:aws:s3:::my-bucket/*"] },
        ],
      },
    };
    const m = parseManifest(withExtraIam);
    const plan = planResources(m, minimalProps({ manifest: m }));
    const s3Perm = plan.extraPermissions.find((p) =>
      p.actions.includes("s3:GetObject")
    );
    expect(s3Perm).toBeDefined();
  });

  it("props.permissions are merged into extraPermissions", () => {
    const p = minimalProps({
      permissions: [{ actions: ["bedrock:InvokeAgent"], resources: ["*"] }],
    });
    const plan = planResources(manifest, p);
    const perm = plan.extraPermissions.find((pm) =>
      pm.actions.includes("bedrock:InvokeAgent")
    );
    expect(perm).toBeDefined();
  });
});

describe("planResources — manifest blob snapshot", () => {
  const manifest = parseManifest(SUPPORT_TRIAGE_RAW);

  it("manifestBlob round-trips through JSON.parse", () => {
    const plan = planResources(manifest, minimalProps());
    const parsed: unknown = JSON.parse(plan.manifestBlob);
    expect(parsed).toMatchObject({ agent: { agentId: "support-triage" } });
  });

  it("manifestRevision is the manifest revision string", () => {
    const plan = planResources(manifest, minimalProps());
    expect(plan.manifestRevision).toBe("rev_a3f91c08b7");
  });
});
