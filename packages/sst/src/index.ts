// SPDX-License-Identifier: Apache-2.0
// @draht/sst — deploy surface stub (P6 implements the full factory)
//
// Factory functions instantiated INSIDE SST run(). ZERO top-level @pulumi/* or @sst/platform imports.
// aws.*, sst.aws.*, $util, $app, $jsonStringify accessed via ambient globals (src/globals.d.ts).
//
// DESIGN (per adversarial verification A.3, locked):
// - NOT a class extending SST's Component (sst.Component is NOT exported from sst npm package)
// - Factory functions composing public sst.aws.Queue/Function/Bus/Dynamo/Cron + raw aws.*
// - Linkability via new sst.Linkable(name, { properties, include }) ONLY
// - Default storage: managed own DynamoDB (removal:'retain' + deletionProtection) — NOT shared
// - Shared-table mode is opt-in, high-risk, gated by isolation test (fr3n's GSI schema conflict)
//
// Usage in fr3n's sst.config.ts:
//   import { draht } from "@draht/sst";
//   const supportAgent = draht.Agent("Fr3nSupportAgent", { manifest: "./agents/support/.platine/manifest.json", ... });

export {};
