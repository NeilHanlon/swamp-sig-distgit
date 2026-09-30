/**
 * Unit tests for the `@kneel/sig-distgit` fan-out scan model.
 *
 * Two layers:
 *  - Pure helpers: auth headers, URL construction, the SpecVersion→fact mapping,
 *    the summary reduction, and the retry-on-429 wrapper.
 *  - The scan path through a mocked {@link FetchLike} seam: project pagination
 *    (x-next-page), per-project spec fetch, and classification into
 *    resolved / unparsed / missing-branch / error buckets.
 *
 * The keystone fixture is the real `openstack-keystone.spec` header on
 * `c9s-sig-cloud-epoxy` (Epoch 1, Version 27.0.0 — genuinely behind upstream
 * 27.0.2, which is the inventory working as designed).
 *
 * Run with: `~/.deno/bin/deno test extensions/models/sig_distgit_test.ts`
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  authHeaders,
  buildScanSummary,
  type FetchLike,
  fetchWithRetry,
  listProjects,
  type Project,
  projectsPageUrl,
  rawSpecUrl,
  redactUrl,
  scanProjects,
  toPackageFact,
} from "./sig_distgit.ts";
import { resolveSpecVersion } from "../lib/spec_version.ts";

const KEYSTONE_SPEC = `%global service keystone
Name:           openstack-keystone
Epoch:          1
Version:        27.0.0
Release:        1%{?dist}
Summary:        OpenStack Identity Service
`;

const MACRO_SPEC = `%global upstream_version 18.6.0
Name:    openstack-foo
Version: %{upstream_version}
Release: 1%{?dist}
`;

const UNPARSED_SPEC = `Name:    openstack-bar
Version: %{undefined_macro}
Release: 1%{?dist}
`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("authHeaders: PAT sent as PRIVATE-TOKEN, absent when empty", () => {
  assertEquals(authHeaders(""), {});
  assertEquals(authHeaders("glpat-xyz"), { "PRIVATE-TOKEN": "glpat-xyz" });
});

Deno.test("projectsPageUrl: encodes group, includes subgroups, stable order", () => {
  const u = projectsPageUrl("https://gitlab.com", "CentOS/cloud/rpms", 2);
  assertEquals(u.includes("groups/CentOS%2Fcloud%2Frpms/projects"), true);
  assertEquals(u.includes("include_subgroups=true"), true);
  assertEquals(u.includes("page=2"), true);
  assertEquals(u.includes("order_by=path"), true);
});

Deno.test("rawSpecUrl: <name>.spec at ref, by project id", () => {
  const u = rawSpecUrl("https://gitlab.com", 84057815, "openstack-keystone", "c9s-sig-cloud-epoxy");
  assertEquals(
    u,
    "https://gitlab.com/api/v4/projects/84057815/repository/files/openstack-keystone.spec/raw?ref=c9s-sig-cloud-epoxy",
  );
});

Deno.test("toPackageFact: real keystone spec -> 27.0.0, epoch 1, resolved", () => {
  const sv = resolveSpecVersion(KEYSTONE_SPEC);
  const f = toPackageFact("openstack-keystone", 84057815, "c9s-sig-cloud-epoxy", sv);
  assertEquals(f.distgit, "openstack-keystone");
  assertEquals(f.version, "27.0.0");
  assertEquals(f.epoch, "1");
  assertEquals(f.release, "1"); // %{?dist} stripped
  assertEquals(f.resolved, true);
  assertEquals(f.unresolvedReason, undefined);
});

Deno.test("toPackageFact: unparsed spec carries raw line + reason", () => {
  const sv = resolveSpecVersion(UNPARSED_SPEC);
  const f = toPackageFact("openstack-bar", 1, "b", sv);
  assertEquals(f.resolved, false);
  assertEquals(f.version, null);
  assertEquals(f.versionRaw, "%{undefined_macro}");
  assertEquals(typeof f.unresolvedReason, "string");
});

Deno.test("buildScanSummary: counts each bucket and lists unparsed raw lines", () => {
  const summary = buildScanSummary(
    {
      gitlabUrl: "https://gitlab.com",
      group: "CentOS/cloud/rpms",
      branch: "c9s-sig-cloud-epoxy",
      token: "",
      concurrency: 5,
      maxProjects: 0,
    },
    {
      totalProjects: 5,
      packages: [
        toPackageFact("openstack-keystone", 1, "b", resolveSpecVersion(KEYSTONE_SPEC)),
        toPackageFact("openstack-bar", 2, "b", resolveSpecVersion(UNPARSED_SPEC)),
      ],
      missingBranch: ["rust-capn", "golang-x"],
      errorPackages: [{ distgit: "flaky", reason: "HTTP 500 err" }],
    },
    false,
  );
  assertEquals(summary.totalProjects, 5);
  assertEquals(summary.truncated, false);
  assertEquals(summary.scanned, 2);
  assertEquals(summary.missingBranch, 2);
  assertEquals(summary.unparsed, 1);
  assertEquals(summary.errors, 1);
  assertEquals(summary.authenticated, false);
  assertEquals(summary.unparsedPackages, [{ distgit: "openstack-bar", rawLine: "%{undefined_macro}" }]);
});

// ---------------------------------------------------------------------------
// Fetch seam helpers
// ---------------------------------------------------------------------------

/** Response spec for the URL-routed fake fetch. */
interface Resp {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Build a FetchLike that maps exact URLs to responses; unknown -> 404. */
function urlFetcher(routes: Record<string, Resp>): { f: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const f: FetchLike = (input) => {
    calls.push(input);
    const r = routes[input] ?? { status: 404 };
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 404 ? "Not Found" : r.status === 200 ? "OK" : "Error",
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      text: () => Promise.resolve(r.body ?? ""),
    });
  };
  return { f, calls };
}

Deno.test("fetchWithRetry: retries a 429 then succeeds (Retry-After honoured, short)", async () => {
  let n = 0;
  const f: FetchLike = () => {
    n++;
    const status = n === 1 ? 429 : 200;
    return Promise.resolve({
      ok: status === 200,
      status,
      statusText: "x",
      headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "0" : null) },
      text: () => Promise.resolve("ok"),
    });
  };
  const resp = await fetchWithRetry("https://x", {}, f, 3);
  assertEquals(resp.status, 200);
  assertEquals(n, 2);
});

Deno.test("fetchWithRetry: retries a transient 500 then succeeds", async () => {
  let n = 0;
  const f: FetchLike = () => {
    n++;
    const status = n <= 2 ? 500 : 200;
    return Promise.resolve({
      ok: status === 200,
      status,
      statusText: "x",
      headers: { get: () => null },
      text: () => Promise.resolve("ok"),
    });
  };
  const resp = await fetchWithRetry("https://x", {}, f, 3);
  assertEquals(resp.status, 200);
  assertEquals(n, 3);
});

Deno.test("fetchWithRetry: a 404 is definitive — returned without retry", async () => {
  let n = 0;
  const f: FetchLike = () => {
    n++;
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      text: () => Promise.resolve(""),
    });
  };
  const resp = await fetchWithRetry("https://x", {}, f, 3);
  assertEquals(resp.status, 404);
  assertEquals(n, 1);
});

Deno.test("fetchWithRetry: a thrown fetch (timeout/reset) is retried and then succeeds", async () => {
  // AR-1: the previous implementation called `doFetch` bare; any thrown
  // rejection (DNS/timeout/reset) skipped the retry path entirely and the
  // package landed in errorPackages. Wrapping in try/catch treats a thrown
  // fetch as retriable like 429/5xx.
  let n = 0;
  const f: FetchLike = () => {
    n++;
    if (n === 1) return Promise.reject(new TypeError("connection reset"));
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: () => Promise.resolve("ok"),
    });
  };
  const resp = await fetchWithRetry("https://x", {}, f, 3);
  assertEquals(resp.status, 200);
  assertEquals(n, 2);
});

Deno.test("fetchWithRetry: thrown fetch rethrown after maxRetries exhausted", async () => {
  let n = 0;
  const f: FetchLike = () => {
    n++;
    return Promise.reject(new TypeError("network unreachable"));
  };
  let thrown: unknown = null;
  try {
    await fetchWithRetry("https://x", {}, f, 2);
  } catch (e) {
    thrown = e;
  }
  // 1 initial + 2 retries = 3 attempts total
  assertEquals(n, 3);
  assertEquals(thrown instanceof TypeError, true);
});

// ---------------------------------------------------------------------------
// listProjects + scanProjects (injected fetch)
// ---------------------------------------------------------------------------

const CFG = {
  gitlabUrl: "https://gitlab.com",
  group: "CentOS/cloud/rpms",
  branch: "c9s-sig-cloud-epoxy",
  token: "",
  concurrency: 4,
  maxProjects: 0,
};

Deno.test("listProjects: follows x-next-page across pages", async () => {
  const p1 = projectsPageUrl(CFG.gitlabUrl, CFG.group, 1);
  const p2 = projectsPageUrl(CFG.gitlabUrl, CFG.group, 2);
  const { f } = urlFetcher({
    [p1]: {
      status: 200,
      body: JSON.stringify([{ id: 1, path: "openstack-keystone" }, { id: 2, path: "rust-capn" }]),
      headers: { "x-next-page": "2" },
    },
    [p2]: {
      status: 200,
      body: JSON.stringify([{ id: 3, path: "openstack-foo" }]),
      headers: { "x-next-page": "" },
    },
  });
  const noop = () => {};
  const { projects, truncated } = await listProjects(CFG, f, {
    debug: noop,
    info: noop,
    warning: noop,
    error: noop,
  });
  assertEquals(projects.map((p) => p.path), ["openstack-keystone", "rust-capn", "openstack-foo"]);
  assertEquals(truncated, false);
});

Deno.test("listProjects: maxProjects caps the scan mid-page", async () => {
  const p1 = projectsPageUrl(CFG.gitlabUrl, CFG.group, 1);
  const { f } = urlFetcher({
    [p1]: {
      status: 200,
      body: JSON.stringify([{ id: 1, path: "a" }, { id: 2, path: "b" }, { id: 3, path: "c" }]),
      headers: { "x-next-page": "2" },
    },
  });
  const noop = () => {};
  const { projects, truncated } = await listProjects(
    { ...CFG, maxProjects: 2 },
    f,
    { debug: noop, info: noop, warning: noop, error: noop },
  );
  assertEquals(projects.map((p) => p.path), ["a", "b"]);
  assertEquals(truncated, false);
});

Deno.test("listProjects: raises on a listing HTTP error", async () => {
  const { f } = urlFetcher({}); // page 1 -> 404
  const noop = () => {};
  await assertRejects(
    () =>
      listProjects(CFG, f, { debug: noop, info: noop, warning: noop, error: noop }),
    Error,
    "failed",
  );
});

Deno.test("listProjects: hard cap truncates at MAX_PAGINATION_PAGES and warns (SR-2)", async () => {
  // Build a fetch that always reports a next page (an infinite pagination trap).
  // The cap is 50 pages, so we expect listProjects to stop and warn.
  const f: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (n: string) => (n.toLowerCase() === "x-next-page" ? "next" : null) },
      text: () => Promise.resolve(JSON.stringify([{ id: 1, path: "p" }])),
    });
  const warnings: string[] = [];
  const { projects, truncated } = await listProjects(
    { ...CFG, maxProjects: 0 },
    f,
    {
      debug: () => {},
      info: () => {},
      warning: (m) => warnings.push(m),
      error: () => {},
    },
  );
  assertEquals(truncated, true);
  // 50 pages * 1 project per page = 50 projects
  assertEquals(projects.length, 50);
  assertEquals(warnings.some((w) => w.includes("hard cap")), true);
});

// ---------------------------------------------------------------------------
// redactUrl (NEW-3)
// ---------------------------------------------------------------------------

Deno.test("redactUrl: strips http(s) URLs from error messages", () => {
  assertEquals(
    redactUrl("fetch failed: connection reset at https://gitlab.com/api/v4/projects/1/repository/files/x.spec/raw?ref=b"),
    "fetch failed: connection reset at <url>",
  );
  assertEquals(
    redactUrl("GET http://example.com/foo failed"),
    "GET <url> failed",
  );
  // No URL — unchanged
  assertEquals(redactUrl("connection reset"), "connection reset");
  // Multiple URLs
  assertEquals(
    redactUrl("tried https://a then http://b"),
    "tried <url> then <url>",
  );
});

Deno.test("scanProjects: classifies resolved / unparsed / missing / error", async () => {
  const projects: Project[] = [
    { id: 1, path: "openstack-keystone" },
    { id: 2, path: "openstack-foo" },
    { id: 3, path: "openstack-bar" },
    { id: 4, path: "rust-capn" }, // no spec -> 404 missing branch
    { id: 5, path: "flaky" }, // 500 -> error
  ];
  const routes: Record<string, Resp> = {
    [rawSpecUrl(CFG.gitlabUrl, 1, "openstack-keystone", CFG.branch)]: { status: 200, body: KEYSTONE_SPEC },
    [rawSpecUrl(CFG.gitlabUrl, 2, "openstack-foo", CFG.branch)]: { status: 200, body: MACRO_SPEC },
    [rawSpecUrl(CFG.gitlabUrl, 3, "openstack-bar", CFG.branch)]: { status: 200, body: UNPARSED_SPEC },
    [rawSpecUrl(CFG.gitlabUrl, 5, "flaky", CFG.branch)]: { status: 500 },
    // project 4 (rust-capn) intentionally absent -> 404
  };
  const { f } = urlFetcher(routes);
  const result = await scanProjects(CFG, projects, f);

  assertEquals(result.packages.map((p) => p.distgit), ["openstack-bar", "openstack-foo", "openstack-keystone"]);
  const keystone = result.packages.find((p) => p.distgit === "openstack-keystone")!;
  assertEquals(keystone.version, "27.0.0");
  const foo = result.packages.find((p) => p.distgit === "openstack-foo")!;
  assertEquals(foo.version, "18.6.0"); // macro-resolved
  const bar = result.packages.find((p) => p.distgit === "openstack-bar")!;
  assertEquals(bar.resolved, false);
  assertEquals(result.missingBranch, ["rust-capn"]);
  assertEquals(result.errorPackages, [{ distgit: "flaky", reason: "HTTP 500 Error" }]);
  assertEquals(result.totalProjects, 5);
});

// ---------------------------------------------------------------------------
// NEW-2: monotonic backoff + NEW-3: URL redaction in error reasons
// ---------------------------------------------------------------------------

Deno.test("fetchWithRetry: backoff never drops after a Retry-After lifts the floor (NEW-2)", async () => {
  // Regime sequence: thrown (linear 1s) → 429 w/ Retry-After 5s → thrown.
  // After the 5s Retry-After, the linear floor must be >= 6s for the next
  // thrown-retry wait — it must not reset to 2s just because `attempt` grew.
  const waits: number[] = [];
  const origSleep = globalThis.setTimeout;
  // Intercept sleep by overriding setTimeout for short timeouts; capture the
  // delay each retry takes. Simpler: spy on Date.now — but Deno has no stable
  // fake-timers. Instead, capture the delay by wrapping doFetch and timing.
  let n = 0;
  const f: FetchLike = () => {
    n++;
    if (n === 1) return Promise.reject(new TypeError("throw 1"));
    if (n === 2) {
      return Promise.resolve({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "5" : null) },
        text: () => Promise.resolve("slow down"),
      });
    }
    if (n === 3) return Promise.reject(new TypeError("throw 2"));
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: () => Promise.resolve("ok"),
    });
  };
  // Patch the module's sleep by overriding setTimeout for the test — record
  // the delay passed to each setTimeout call whose callback does nothing
  // (i.e. sleep calls).
  const recorded: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = ((cb: () => void, ms?: number) => {
    if (ms !== undefined) recorded.push(ms);
    return realSetTimeout(cb, 0); // execute immediately for the test
    // deno-lint-ignore no-explicit-any
  }) as any;
  try {
    const resp = await fetchWithRetry("https://x", {}, f, 5);
    assertEquals(resp.status, 200);
    assertEquals(n, 4);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).setTimeout = realSetTimeout;
  }
  // Wait sequence:
  //   attempt 0 thrown   -> wait linearMs(1000) = 1000, then linearMs=2000
  //   attempt 1 429 RA=5 -> wait 5000 (RA>linearMs), then linearMs = max(3000, 6000) = 6000
  //   attempt 2 thrown   -> wait linearMs(6000) = 6000, then linearMs=7000
  //   attempt 3 success  -> no wait
  assertEquals(recorded, [1000, 5000, 6000]);
});

Deno.test("scanProjects: URL embedded in thrown error message is redacted (NEW-3)", async () => {
  const projects: Project[] = [{ id: 99, path: "url-leaky" }];
  const url = rawSpecUrl(CFG.gitlabUrl, 99, "url-leaky", CFG.branch);
  const f: FetchLike = () =>
    Promise.reject(
      new Error(`fetch failed: connection refused at ${url} after 30s`),
    );
  const result = await scanProjects(CFG, projects, f);
  assertEquals(result.errorPackages.length, 1);
  const reason = result.errorPackages[0].reason;
  assertEquals(reason.includes("gitlab.com"), false);
  assertEquals(reason.includes("<url>"), true);
  assertEquals(reason.startsWith("fetch threw:"), true);
});
