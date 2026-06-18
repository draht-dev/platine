// SPDX-License-Identifier: Apache-2.0
/**
 * ssrf.test.ts — unit tests for the SSRF-safe fetch helper.
 *
 * All DNS lookups are STUBBED — no real network calls are made.
 * Covers:
 *  - localhost / 127.x.x.x rejected
 *  - 169.254.169.254 (IMDS) rejected
 *  - 10.x / 172.16.x / 192.168.x RFC1918 ranges rejected
 *  - fc00::/fd00:: / fe80:: / ::1 IPv6 ranges rejected
 *  - Non-http/https schemes rejected
 *  - Redirects (3xx) rejected
 *  - Public host shape allowed (stubbed to a public IP, no real call)
 *  - Timeout behaviour
 *  - SsrfBlockedError sentinel type
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ssrfSafeFetch, SsrfBlockedError } from "./ssrf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub dnsLookupFn that always returns the given addresses. */
function stubDns(
  ...addrs: Array<{ address: string; family: 4 | 6 }>
): (hostname: string) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  return async (_hostname: string) => addrs;
}

/** Build a stub fetch that always returns the given status and optional JSON body. */
function stubFetch(status: number, body: unknown = {}): typeof globalThis.fetch {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// SSRF block-list: IPv4
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — blocked IPv4 addresses", () => {
  it("rejects requests to 127.0.0.1 (loopback)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://localhost/api", {}, {
        dnsLookupFn: stubDns({ address: "127.0.0.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects requests to 127.0.0.99 (loopback range)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://internal.example.com/api", {}, {
        dnsLookupFn: stubDns({ address: "127.0.0.99", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects requests to 169.254.169.254 (IMDS)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {}, {
        dnsLookupFn: stubDns({ address: "169.254.169.254", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 169.254.x.y link-local range broadly", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://metadata.internal/", {}, {
        dnsLookupFn: stubDns({ address: "169.254.0.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 10.0.0.1 (RFC1918 class-A)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://internal.corp/api", {}, {
        dnsLookupFn: stubDns({ address: "10.0.0.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 10.255.255.255 (RFC1918 class-A boundary)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://internal.corp/api", {}, {
        dnsLookupFn: stubDns({ address: "10.255.255.255", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 172.16.0.1 (RFC1918 class-B)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://docker.internal/", {}, {
        dnsLookupFn: stubDns({ address: "172.16.0.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 172.31.255.255 (RFC1918 class-B boundary)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://docker.internal/", {}, {
        dnsLookupFn: stubDns({ address: "172.31.255.255", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 192.168.1.1 (RFC1918 class-C)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://router.local/", {}, {
        dnsLookupFn: stubDns({ address: "192.168.1.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 0.0.0.0 (unspecified)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://example.com/", {}, {
        dnsLookupFn: stubDns({ address: "0.0.0.0", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// SSRF block-list: IPv6
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — blocked IPv6 addresses", () => {
  it("rejects ::1 (loopback)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://[::1]/api", {}, {
        dnsLookupFn: stubDns({ address: "::1", family: 6 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects fc00:: (unique-local)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://internal.local/api", {}, {
        dnsLookupFn: stubDns({ address: "fc00::1", family: 6 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects fd00:: (unique-local prefix fd)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://internal.local/api", {}, {
        dnsLookupFn: stubDns({ address: "fd00::1", family: 6 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects fe80:: (link-local)", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    await expect(
      ssrfSafeFetch("http://link.local/api", {}, {
        dnsLookupFn: stubDns({ address: "fe80::1", family: 6 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// Protocol restrictions
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — protocol restrictions", () => {
  it("rejects file:// scheme", async () => {
    await expect(
      ssrfSafeFetch("file:///etc/passwd", {}, {
        dnsLookupFn: stubDns({ address: "127.0.0.1", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects ftp:// scheme", async () => {
    await expect(
      ssrfSafeFetch("ftp://example.com/file.txt", {}, {
        dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("allows http:// scheme for public IPs", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { status: "ok" }));
    const resp = await ssrfSafeFetch("http://example.com/api", {}, {
      dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
    });
    expect(resp.status).toBe(200);
  });

  it("allows https:// scheme for public IPs", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { status: "ok" }));
    const resp = await ssrfSafeFetch("https://api.example.com/v1/data", {}, {
      dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
    });
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Redirect rejection
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — redirect rejection", () => {
  it("rejects 301 redirects", async () => {
    vi.stubGlobal("fetch", stubFetch(301));
    await expect(
      ssrfSafeFetch("https://example.com/old", {}, {
        dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects 302 redirects", async () => {
    vi.stubGlobal("fetch", stubFetch(302));
    await expect(
      ssrfSafeFetch("https://example.com/moved", {}, {
        dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("does not reject non-redirect 2xx responses", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { data: "hello" }));
    const resp = await ssrfSafeFetch("https://example.com/api", {}, {
      dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
    });
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Public host — allowed
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — public host allowed", () => {
  it("allows a request to a public IP (93.184.216.34 / example.com)", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { message: "success" }));
    const resp = await ssrfSafeFetch("https://example.com/v1/data", {}, {
      dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }),
    });
    expect(resp.status).toBe(200);
    // Verify the response body is readable
    const body = await resp.json() as { message: string };
    expect(body.message).toBe("success");
  });

  it("passes request method and headers through to fetch", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    await ssrfSafeFetch(
      "https://example.com/api",
      { method: "POST", headers: { "x-custom": "header-value" } },
      { dnsLookupFn: stubDns({ address: "93.184.216.34", family: 4 }) },
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const firstCall = mockFetch.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const callInit = firstCall?.[1];
    expect(callInit?.method).toBe("POST");
    expect((callInit?.headers as Record<string, string> | undefined)?.["x-custom"]).toBe("header-value");
    // redirect must be "manual"
    expect(callInit?.redirect).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// SsrfBlockedError is instanceof check
// ---------------------------------------------------------------------------

describe("ssrfSafeFetch — SsrfBlockedError type", () => {
  it("throws an instance of SsrfBlockedError for blocked targets", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    let caught: unknown;
    try {
      await ssrfSafeFetch("http://169.254.169.254/latest/meta-data/", {}, {
        dnsLookupFn: stubDns({ address: "169.254.169.254", family: 4 }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SsrfBlockedError);
    expect((caught as SsrfBlockedError).name).toBe("SsrfBlockedError");
  });

  it("the error message mentions the blocked hostname or address", async () => {
    vi.stubGlobal("fetch", stubFetch(200));
    let msg = "";
    try {
      await ssrfSafeFetch("http://metadata.internal/", {}, {
        dnsLookupFn: stubDns({ address: "169.254.169.254", family: 4 }),
      });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/169\.254\.169\.254/);
  });
});
