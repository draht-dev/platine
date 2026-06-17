// SPDX-License-Identifier: Apache-2.0
/**
 * channel-slack.ts — SlackChannel implements InboundChannel.
 *
 * Inbound Slack event verification using HMAC-SHA256 signature.
 *
 * ## Signature Verification
 * Slack signs all requests using the app's Signing Secret (from App Settings).
 * The verification process:
 *   1. Read the `X-Slack-Request-Timestamp` header (Unix epoch seconds).
 *   2. Reject requests older than 5 minutes (replay attack prevention).
 *   3. Build the base string: `v0:<timestamp>:<raw_body>`
 *   4. Compute HMAC-SHA256 over the base string using the signing secret.
 *   5. Prefix with `v0=` and compare (timing-safe) against `X-Slack-Signature`.
 *
 * References:
 *   https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * parse() returns:
 *   { kind:"ack", response:{ challenge } }  — URL verification challenge
 *   { kind:"run", env }                     — verified event, ready to submit
 *   { kind:"reject" }                       — bad signature, stale timestamp, malformed body
 */

import { createHmac } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

import type { InboundChannel } from "@draht/core/seams";
import type { InboundEnvelope } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

export interface SlackChannelOptions {
  /**
   * channelId — identifies this channel in the manifest.
   */
  channelId: string;
  /**
   * signingSecret — the Slack app's signing secret (from App Settings → Basic Info).
   * Used for HMAC-SHA256 signature verification.
   */
  signingSecret: string;
  /**
   * maxAgeSeconds — maximum allowed age of a request (default: 300 = 5 minutes).
   * Prevents replay attacks.
   */
  maxAgeSeconds?: number;
}

export class SlackChannel implements InboundChannel {
  private readonly channelId: string;
  private readonly signingSecret: string;
  private readonly maxAgeSeconds: number;

  constructor(opts: SlackChannelOptions) {
    this.channelId     = opts.channelId;
    this.signingSecret = opts.signingSecret;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 300;
  }

  /**
   * parse() — verifies Slack's HMAC-SHA256 signature and normalizes the event.
   *
   * Verification steps:
   * 1. Extract X-Slack-Request-Timestamp and X-Slack-Signature headers.
   * 2. Reject if timestamp is more than maxAgeSeconds old (replay guard).
   * 3. Compute HMAC-SHA256(signing_secret, "v0:" + timestamp + ":" + raw_body).
   * 4. Compare computed "v0=" + hex with the X-Slack-Signature header (timing-safe).
   * 5. Parse the JSON body and normalize to InboundEnvelope.
   */
  async parse(req: {
    headers: Record<string, string>;
    body: string;
    rawBody: Buffer;
  }): Promise<
    | { kind: "run"; env: InboundEnvelope }
    | { kind: "ack"; response: unknown }
    | { kind: "reject" }
  > {
    // Extract Slack headers (case-insensitive lookup)
    const timestamp = req.headers["x-slack-request-timestamp"] ?? req.headers["X-Slack-Request-Timestamp"];
    const signature = req.headers["x-slack-signature"] ?? req.headers["X-Slack-Signature"];

    if (timestamp === undefined || signature === undefined) {
      return { kind: "reject" };
    }

    // Replay attack prevention: reject stale requests
    const tsNum = parseInt(timestamp, 10);
    if (isNaN(tsNum)) {
      return { kind: "reject" };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - tsNum) > this.maxAgeSeconds) {
      return { kind: "reject" };
    }

    // Compute expected HMAC signature
    // Slack's algorithm: v0=HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)
    const rawBodyStr = req.rawBody.toString("utf-8");
    const baseString = `v0:${timestamp}:${rawBodyStr}`;
    const hmac = createHmac("sha256", this.signingSecret).update(baseString).digest("hex");
    const expected = `v0=${hmac}`;

    // Timing-safe comparison (prevents timing attacks)
    const expectedBuf = Buffer.from(expected, "utf-8");
    const receivedBuf = Buffer.from(signature, "utf-8");
    if (
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      return { kind: "reject" };
    }

    // Signature is valid — parse the JSON body
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { kind: "reject" };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "reject" };
    }

    const body = parsed as Record<string, unknown>;

    // Handle URL verification challenge (Slack sends this when configuring the webhook)
    if (body["type"] === "url_verification") {
      return {
        kind: "ack",
        response: { challenge: body["challenge"] ?? "" },
      };
    }

    // Normalize to InboundEnvelope
    const payload: Record<string, unknown> = {};

    // Slack event_callback shape: { type:"event_callback", event:{...}, team_id, ... }
    if (typeof body["event"] === "object" && body["event"] !== null) {
      Object.assign(payload, body["event"] as Record<string, unknown>);
    } else {
      Object.assign(payload, body);
    }

    const env: InboundEnvelope = {
      channelId: this.channelId,
      payload,
      ...(typeof body["team_id"] === "string" ? { tenantHint: body["team_id"] } : {}),
      rawBody: req.body,
    };

    return { kind: "run", env };
  }
}

// ---------------------------------------------------------------------------
// Exported helper for tests
// ---------------------------------------------------------------------------

/**
 * buildSlackSignature — creates a valid X-Slack-Signature for testing.
 * Computes v0=HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody).
 */
export function buildSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return `v0=${hmac}`;
}
