// SPDX-License-Identifier: Apache-2.0
// Branded ID types for type-safe tenant/run/step identity.

export type TenantId = string & { __brand: "TenantId" };
export type RunId    = string & { __brand: "RunId" };
export type StepId   = string & { __brand: "StepId" };

export const DEFAULT_TENANT = "default" as TenantId;
