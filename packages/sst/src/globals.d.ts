// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/sst — ambient globals for the SST/Pulumi runtime environment.
 *
 * CRITICAL (per adversarial verification A.3):
 * - @draht/sst must contain ZERO top-level @pulumi/* or @sst/platform imports.
 * - sst.Component is NOT in sst's npm exports map, NOT in the injected `sst` global.
 * - The supported pattern: compose public sst.aws.* + raw aws.* via globally-injected namespaces.
 * - Linkability: sst.Linkable ONLY (new sst.Linkable(...)).
 *
 * Consumers must add to their sst.config.ts:
 *   /// <reference path="./.sst/platform/config.d.ts" />
 *
 * These declarations allow @draht/sst to typecheck in ISOLATION (without the SST
 * platform present). Typed loosely (any/minimal) — the platform's own config.d.ts
 * provides the real types at consumer-app typecheck time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Raw Pulumi aws provider (aws.cloudwatch.MetricAlarm, aws.iam.Role, etc.)
declare const aws: any;

// SST namespace: sst.aws.Queue/Function/Bus/Dynamo/Cron/Router + sst.Linkable
declare const sst: any;

// Pulumi utilities injected by the SST platform ($util.ComponentResource etc.)
declare const $util: any;

// SST app metadata ($app.name, $app.stage, $app.providers)
declare const $app: any;

// JSON-stringify helper injected by SST ($jsonStringify turns outputs into strings)
declare const $jsonStringify: any;
