// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/sst — the ONLY deploy surface for the draht agent framework.
 *
 * DESIGN (per adversarial verification A.3, locked):
 * - NOT a class extending SST's Component (sst.Component is NOT exported from sst npm package)
 * - Factory functions composing public sst.aws.Queue/Function/Bus/Dynamo/Cron + raw aws.*
 * - Linkability via new sst.Linkable(name, { properties, include }) ONLY
 * - Default storage: managed own DynamoDB (removal:'retain' + deletionProtection)
 * - Shared-table mode is opt-in, high-risk (see A.3)
 * - ZERO top-level @pulumi/* or @sst/platform imports
 *   aws.*, sst.aws.*, $util, $app, $jsonStringify via ambient globals (globals.d.ts)
 *
 * Usage in fr3n's sst.config.ts:
 *   import { draht } from "@draht/sst";
 *   const supportAgent = draht.Agent("Fr3nSupportAgent", {
 *     manifest: "./agents/support/.platine/manifest.json",
 *     ...
 *   });
 */

import { readFileSync } from "node:fs";
import { parseManifest } from "@draht/manifest";
import type { Manifest } from "@draht/manifest";
import { planResources } from "./plan.js";
import type { ResourcePlan } from "./plan.js";
import type { DrahtAgentProps, DrahtAgentOutput } from "./types.js";

export type { DrahtAgentProps, DrahtAgentOutput };
export { planResources };
export type { ResourcePlan };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and parse the manifest from either an inline object or a file path.
 * Called synchronously at Pulumi-program time — before any resource declarations.
 */
function resolveManifest(manifestProp: Manifest | string): Manifest {
  if (typeof manifestProp === "string") {
    const raw: unknown = JSON.parse(readFileSync(manifestProp, "utf8"));
    return parseManifest(raw);
  }
  return manifestProp;
}

/**
 * Resolve the handler path for a named handler in @draht/runtime-aws/handlers.
 *
 * The SST Function `handler` prop accepts `"<file>.<export>"` relative to the
 * bundle root, or an absolute path. We use require.resolve() to find the stable
 * subpath at Pulumi-program time so the path survives moves.
 */
function resolveHandlerPath(handlerExport: string): string {
  // require.resolve finds the entry for the subpath in node_modules.
  // The resolved path is absolute; SST's esbuild bundler traces from there.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolved: string = require.resolve(
    `@draht/runtime-aws/handlers`
  );
  // SST's Function `handler` is "<file>.<export>" where <file> has NO bundler
  // extension (SST resolves .js/.cjs/.mjs itself). Leaving ".cjs" in the middle
  // makes SST mis-split "index.cjs.executorHandler" → "Handler not found".
  const noExt = resolved.replace(/\.(c|m)?js$/, "");
  return `${noExt}.${handlerExport}`;
}

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

/**
 * draht.Agent() — provision all AWS resources for a draht agent.
 *
 * Must be called inside an SST `run()` function so the injected globals
 * (sst, aws, $util, $app, $jsonStringify) are in scope.
 *
 * Resource composition order:
 *  1.  Parse manifest
 *  2.  Derive ResourcePlan (pure, testable)
 *  3.  DLQ  → sst.aws.Queue
 *  4.  Main queue → sst.aws.Queue (visibilityTimeout > Lambda timeout)
 *  5.  EventBridge bus → sst.aws.Bus or reuse props.bus
 *  6.  DynamoDB table → managed sst.aws.Dynamo (retain+deletionProtection) or shared
 *  7.  Executor Lambda → sst.aws.Function (handler = @draht/runtime-aws/handlers executor)
 *  8.  Cron triggers → sst.aws.Cron per schedule trigger
 *  9.  HTTP routes  → router.route(path, fn) or Function URL
 * 10.  DLQ CloudWatch alarm → aws.cloudwatch.MetricAlarm
 * 11.  sst.Linkable → exposes {queueUrl, busName, tableName, httpUrl, manifestRevision}
 */
export function Agent(name: string, props: DrahtAgentProps): DrahtAgentOutput {
  // 1. Resolve + parse manifest synchronously at Pulumi-program time.
  const manifest = resolveManifest(props.manifest);

  // 2. Derive the pure provisioning plan (no globals touched here).
  const plan = planResources(manifest, props);

  // Common environment variables injected into every Lambda.
  const baseEnv: Record<string, unknown> = {
    DRAHT_MANIFEST_ID: plan.manifestId,
    DRAHT_MANIFEST_REV: plan.manifestRevision,
    NODE_OPTIONS: "--enable-source-maps",
    ...(props.environment ?? {}),
  };

  // 3. Dead-letter queue.
  const dlq = new sst.aws.Queue(`${name}Dlq`, {
    fifo: false,
    ...(props.provider !== undefined ? { transform: { queue: { provider: props.provider } } } : {}),
  });

  // 4. Main SQS queue (visibilityTimeout STRICTLY > Lambda timeout — A.2 must-fix).
  const queue = new sst.aws.Queue(`${name}Queue`, {
    visibilityTimeout: `${plan.visibilityTimeoutSeconds} seconds`,
    dlq: {
      queue: dlq.arn,
      retry: 3,
    },
    ...(props.provider !== undefined ? { transform: { queue: { provider: props.provider } } } : {}),
  });

  // 5. EventBridge bus (own or host-provided).
  const bus: unknown = plan.createBus
    ? new sst.aws.Bus(`${name}Bus`, {
        ...(props.provider !== undefined ? { transform: { bus: { provider: props.provider } } } : {}),
      })
    : props.bus;

  // 6. DynamoDB table.
  //    Managed mode: own table, removal:'retain' + deletionProtection (A.3 + R3 must-fix).
  //    Shared mode:  consumer's table via props.storage.table.
  let table: unknown;
  let tableName: unknown;

  if (plan.storageMode === "managed") {
    const dynamoResource = new sst.aws.Dynamo(`${name}Table`, {
      fields: {
        pk: "string",
        sk: "string",
        gsi1pk: "string",
        gsi1sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        gsi1: { hashKey: "gsi1pk", rangeKey: "gsi1sk" },
      },
      deletionProtection: true,
      transform: {
        table: {
          // removal:'retain' ensures the table survives `sst remove` and redeployments.
          // This is the ONLY setting that makes the "survives redeploy" demo work (R3).
          removalPolicy: "retain",
        },
      },
      ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
    });
    table = dynamoResource;
    tableName = dynamoResource.name;

    // Snapshot the FULL manifest blob into the table at deploy (§4 / A.3 must-fix):
    // pk=MANIFEST#<id>, sk=REV#<rev>, NEVER overwritten. The executor's loadManifest
    // reads exactly this row to run/resume against the pinned revision. The item shape
    // matches DynamoStorage.putManifest() ({ pk, sk, _entity:"Manifest", blob }).
    new aws.dynamodb.TableItem(`${name}ManifestSeed`, {
      tableName: dynamoResource.name,
      hashKey: "pk",
      rangeKey: "sk",
      item: JSON.stringify({
        pk: { S: `MANIFEST#${plan.manifestId}` },
        sk: { S: `REV#${plan.manifestRevision}` },
        _entity: { S: "Manifest" },
        blob: { S: plan.manifestBlob },
      }),
      ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
    });
  } else {
    // Shared mode: use the host table directly.
    const sharedStorage = props.storage as { mode: "shared"; table: unknown; keyPrefix?: string };
    table = sharedStorage.table;
    tableName = (sharedStorage.table as { name: unknown }).name;
  }

  // Executor handler path (resolved via require.resolve at Pulumi-program time).
  let executorHandlerPath: string;
  try {
    executorHandlerPath = resolveHandlerPath("executorHandler");
  } catch {
    // Fallback for environments where require.resolve is unavailable (e.g. ESM pure mode).
    // The consumer must ensure @draht/runtime-aws is in node_modules.
    executorHandlerPath = "node_modules/@draht/runtime-aws/dist/handlers/index.executorHandler";
  }

  // Build the link array for the executor function.
  const executorLinks: unknown[] = [
    queue,
    ...(plan.storageMode === "managed" ? [table] : []),
    ...(props.link ?? []),
  ];

  // Resolve the DynamoDB table ARN for scoped IAM permissions.
  // In managed mode the ARN comes from the dynamoResource; in shared mode it
  // comes from the consumer-supplied table object (which must expose an `arn` prop).
  const tableArn: unknown = plan.storageMode === "managed"
    ? (table as { arn: unknown }).arn
    : (
        (props.storage as { mode: "shared"; table: unknown } | undefined)?.table as
          | { arn: unknown }
          | undefined
      )?.arn ?? (table as { arn: unknown }).arn;

  const busArn: unknown = (bus as { arn?: unknown }).arn ?? "*";

  // Build permissions for the executor function.
  // SECURITY FIX (HIGH 4): scope IAM permissions to specific ARNs instead of "*".
  // Bedrock InvokeModel remains "*" (model ARNs vary and are not knowable at deploy time).
  const executorPermissions: Array<{ actions: string[]; resources: unknown[] }> = [
    // SQS permissions — scoped to the agent's own queue and DLQ.
    { actions: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], resources: [queue.arn, dlq.arn] },
    // EventBridge permissions — scoped to the agent's own bus.
    { actions: ["events:PutEvents"], resources: [busArn] },
    // DynamoDB permissions — scoped to the table and its GSI index paths.
    { actions: [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWrite",
    ], resources: [tableArn, $util.interpolate`${tableArn as string}/index/*`] },
    // Bedrock permissions (when applicable) — remains "*" (model ARNs are not static).
    ...(plan.bedrockPermission !== null ? [plan.bedrockPermission as { actions: string[]; resources: string[] }] : []),
    // Extra permissions from manifest + props.
    ...(plan.extraPermissions as Array<{ actions: string[]; resources: string[] }>),
  ] as Array<{ actions: string[]; resources: string[] }>;

  // Environment for the executor.
  const executorEnv: Record<string, unknown> = {
    ...baseEnv,
    DRAHT_QUEUE_URL: queue.url,
    DRAHT_BUS_NAME: (bus as { name: unknown }).name,
    DRAHT_TABLE_NAME: tableName,
    ...(plan.storageMode === "shared"
      ? { DRAHT_KEY_PREFIX: plan.sharedTableNamespace }
      : {}),
  };

  // Add secret environment variables.
  for (const secret of plan.secrets) {
    executorEnv[secret.envName] = `\${${secret.key}}`;
  }

  // 7. Executor Lambda function.
  const executorFn = new sst.aws.Function(`${name}Executor`, {
    handler: executorHandlerPath,
    timeout: `${plan.timeoutSeconds} seconds`,
    memory: `${plan.memoryMB} MB`,
    environment: executorEnv as Record<string, string>,
    link: executorLinks,
    permissions: executorPermissions,
    ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
  });

  // Subscribe the executor to the main queue.
  queue.subscribe(executorFn.arn, {
    batch: { size: 1 },
  });

  // 8. Cron triggers (one sst.aws.Cron per schedule trigger).
  for (const cron of plan.cronSchedules) {
    let triggerHandlerPath: string;
    try {
      triggerHandlerPath = resolveHandlerPath("triggerHandler");
    } catch {
      triggerHandlerPath = "node_modules/@draht/runtime-aws/dist/handlers/index.triggerHandler";
    }

    new sst.aws.Cron(`${name}Cron${cron.triggerId}`, {
      schedule: cron.schedule,
      job: {
        handler: triggerHandlerPath,
        environment: {
          ...baseEnv,
          DRAHT_QUEUE_URL: queue.url,
          DRAHT_TABLE_NAME: tableName,
          DRAHT_BUS_NAME: (bus as { name: unknown }).name,
        } as Record<string, string>,
        link: executorLinks,
        permissions: executorPermissions,
        ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
      },
    });
  }

  // HTTP routes and URL tracking.
  let httpUrl: unknown = undefined;

  // 9. HTTP routes.
  for (const route of plan.httpRoutes) {
    let ingressHandlerPath: string;
    try {
      ingressHandlerPath = resolveHandlerPath("ingressHandler");
    } catch {
      ingressHandlerPath = "node_modules/@draht/runtime-aws/dist/handlers/index.ingressHandler";
    }

    const channelEnv: Record<string, unknown> = {
      ...baseEnv,
      DRAHT_QUEUE_URL: queue.url,
      DRAHT_TABLE_NAME: tableName,
      DRAHT_BUS_NAME: (bus as { name: unknown }).name,
      ...(route.auth !== undefined ? { DRAHT_CHANNEL_AUTH: route.auth } : {}),
    };

    const ingressFn = new sst.aws.Function(`${name}Ingress${route.channelId}`, {
      handler: ingressHandlerPath,
      environment: channelEnv as Record<string, string>,
      link: executorLinks,
      permissions: executorPermissions,
      ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
    });

    if (route.useRouter) {
      // Attach to host router at the configured path.
      const channelCfg = props.channels?.find((c) => c.kind === "http");
      const routerResource = (channelCfg as { router: unknown } | undefined)?.router;
      if (routerResource !== undefined) {
        (routerResource as { route: (path: string, fn: unknown) => void }).route(
          route.path,
          ingressFn.arn
        );
        httpUrl = `${(routerResource as { url: unknown }).url}${route.path}`;
      }
    } else {
      // Fallback: Function URL (url: true).
      const fnWithUrl = new sst.aws.Function(`${name}IngressUrl${route.channelId}`, {
        handler: ingressHandlerPath,
        url: true,
        environment: channelEnv as Record<string, string>,
        link: executorLinks,
        permissions: executorPermissions,
        ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
      });
      httpUrl = fnWithUrl.url;
    }
  }

  // 10. DLQ CloudWatch alarm.
  //     Fires when the DLQ has >= 1 message visible.
  new aws.cloudwatch.MetricAlarm(`${name}DlqAlarm`, {
    metricName: "ApproximateNumberOfMessagesVisible",
    namespace: "AWS/SQS",
    dimensions: {
      QueueName: dlq.name,
    },
    statistic: "Sum",
    period: 60,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    alarmDescription: `DLQ depth alarm for draht agent ${name}`,
    treatMissingData: "notBreaching",
  });

  // Also provision resume handler (for approval-gate resume API).
  let resumeHandlerPath: string;
  try {
    resumeHandlerPath = resolveHandlerPath("resumeHandler");
  } catch {
    resumeHandlerPath = "node_modules/@draht/runtime-aws/dist/handlers/index.resumeHandler";
  }

  new sst.aws.Function(`${name}Resume`, {
    handler: resumeHandlerPath,
    // SECURITY FIX (CRITICAL 1): require IAM auth on the resume endpoint.
    // A fully-public Function URL (url: true) allows anyone to POST and resolve
    // an approval gate. The `platine runs approve` CLI uses AWS credentials and
    // signs requests with SigV4, so requiring IAM auth is the correct policy.
    url: { authorization: "aws_iam" },
    environment: {
      ...baseEnv,
      DRAHT_QUEUE_URL: queue.url,
      DRAHT_TABLE_NAME: tableName,
      DRAHT_BUS_NAME: (bus as { name: unknown }).name,
    } as Record<string, string>,
    link: executorLinks,
    permissions: executorPermissions,
    ...(props.provider !== undefined ? { providers: { aws: props.provider } } : {}),
  });

  // 11. sst.Linkable — exposes the agent's outputs to other SST components.
  //     include: sst.aws.permission grants for consumers that link this agent.
  //     SECURITY FIX (HIGH 4): scope DynamoDB and EventBridge permissions to
  //     specific ARNs instead of "*".
  const linkable = new sst.Linkable(name, {
    properties: {
      queueUrl: queue.url,
      busName: (bus as { name: unknown }).name,
      tableName,
      httpUrl: httpUrl ?? null,
      manifestRevision: plan.manifestRevision,
    },
    include: [
      sst.aws.permission({
        actions: ["sqs:SendMessage"],
        resources: [queue.arn],
      }),
      sst.aws.permission({
        actions: ["events:PutEvents"],
        resources: [busArn as string],
      }),
      sst.aws.permission({
        actions: [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWrite",
        ],
        resources: [tableArn as string, $util.interpolate`${tableArn as string}/index/*`],
      }),
    ],
  });

  return {
    queueUrl: queue.url,
    httpUrl,
    busName: (bus as { name: unknown }).name,
    tableName,
    manifestRevision: plan.manifestRevision,
    getSSTLink: () => linkable.getSSTLink(),
  };
}

/**
 * draht.Workflow() — same as draht.Agent(); manifest.kind differentiates at runtime.
 *
 * Provided for ergonomic symmetry with `defineWorkflow()` on the authoring side.
 */
export function Workflow(name: string, props: DrahtAgentProps): DrahtAgentOutput {
  return Agent(name, props);
}

/**
 * The `draht` namespace re-export for the canonical usage:
 *   import { draht } from "@draht/sst";
 *   const agent = draht.Agent("MyAgent", { ... });
 */
export const draht = { Agent, Workflow } as const;
