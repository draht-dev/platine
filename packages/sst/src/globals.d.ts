// SPDX-License-Identifier: Apache-2.0
// @draht/sst — ambient globals stub for the SST/Pulumi runtime environment
//
// CRITICAL (per adversarial verification A.3):
// - @draht/sst must contain ZERO top-level @pulumi/* or @sst/platform imports.
// - sst.Component is NOT in sst's npm exports map, NOT in the injected `sst` global.
// - The supported pattern: compose public sst.aws.* + raw aws.* via globally-injected namespaces.
// - Linkability: sst.Linkable ONLY (sst.Linkable.wrap / new sst.Linkable(...)).
//
// Consumers must add to their sst.config.ts:
//   /// <reference path="./.sst/platform/config.d.ts" />
//
// These declarations allow @draht/sst to typecheck in isolation (P0 stub).
// P6 fills in the full factory implementations.

/* eslint-disable @typescript-eslint/no-explicit-any */

declare const aws: any;
declare const sst: any;
declare const $util: any;
declare const $app: any;
declare const $jsonStringify: any;
