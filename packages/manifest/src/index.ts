// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/manifest — stable re-export point for the Manifest schema and types.
 *
 * Both the SST component (Pulumi-program time) and the Runtime (execution time)
 * import from here — this package is the stable pin point for @draht/core/manifest.
 *
 * All consumers should import from "@draht/manifest", never directly from
 * "@draht/core/manifest", to ensure the stable versioning contract is maintained.
 */

export * from "@draht/core/manifest";
