/**
 * Read-only scan of a CentOS Cloud SIG distgit group on gitlab.com.
 *
 * The SIG keeps one project per package under a group (default
 * `CentOS/cloud/rpms`), each carrying a `<name>.spec` on a per-stream branch
 * (default `c9s-sig-cloud-epoxy`). This model lists every project in the group
 * and, for each, fetches that spec at the branch and resolves its
 * `Version:`/`Release:`/`Epoch:` with the shared {@link resolveSpecVersion} —
 * expanding the common RDO `%global upstream_version …` indirection and routing
 * anything it can't expand to an `unparsed` bucket that keeps the raw line.
 *
 * ## Fan-out (one lock acquisition)
 *
 * The whole scan is a single `scan()` method: it paginates the group, fetches
 * every spec with a bounded concurrency pool, and writes both the `packages`
 * facts and the `scan-summary` in one execution — never a per-package loop of
 * separate method runs (which would contend on the per-model lock).
 *
 * ## Scale & rate limits
 *
 * The group is large (subgroups pull the whole tree — hundreds of projects),
 * but only the subset that actually carries the branch's spec is a real Epoxy
 * package; the rest return 404 and land in `missingBranch`. Unauthenticated
 * gitlab.com API is rate-limited (~500/min), so `concurrency` is capped low and
 * an optional PAT (`token`, vault it — never a literal) raises the ceiling and
 * is sent as `PRIVATE-TOKEN`. Transient 429/503 are retried with backoff that
 * honours `Retry-After`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { resolveSpecVersion, type SpecVersion } from "../lib/spec_version.ts";
import { parseSourcesFile, urlSourceBasenames } from "../lib/spec_sources.ts";

/** Connection + scope settings for the distgit scan. */
const GlobalArgsSchema = z.object({
  gitlabUrl: z
    .string()
    .default("https://gitlab.com")
    .describe("GitLab base URL (no trailing slash)"),
  group: z
    .string()
    .default("CentOS/cloud/rpms")
    .describe("Group path whose projects hold the distgit specs"),
  branch: z
    .string()
    .default("c9s-sig-cloud-epoxy")
    .describe("Branch to read each <name>.spec from (a stream marker)"),
  token: z
    .string()
    .default("")
    .meta({ sensitive: true })
    .describe(
      "Optional PAT for rate-limit headroom — vault it, never a literal",
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(5)
    .describe("Max concurrent spec fetches (keep low when unauthenticated)"),
  maxProjects: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Cap on projects scanned (0 = no cap); for fast dev reruns"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

/** One package's resolved spec facts at the scanned branch. */
const PackageFactSchema = z.object({
  distgit: z.string(),
  projectId: z.number().int(),
  branch: z.string(),
  version: z.string().nullable(),
  release: z.string().nullable(),
  epoch: z.string().nullable(),
  versionRaw: z.string().nullable(),
  resolved: z.boolean(),
  unresolvedReason: z.string().optional(),
  urlSources: z.array(z.string()).optional()
    .describe(
      "Basenames of the spec's URL-based Source* lines (lookaside sources)",
    ),
  sourcesEntries: z.array(z.string()).optional()
    .describe("Filenames recorded in the `sources` metadata file"),
});

/** All resolved package facts from one scan. */
const PackagesSchema = z.object({
  branch: z.string(),
  group: z.string(),
  scanned: z.number().int(),
  packages: z.array(PackageFactSchema),
  fetchedAt: z.iso.datetime(),
});

/** Headline counts + the triage lists a human needs after a scan. */
const ScanSummarySchema = z.object({
  branch: z.string(),
  group: z.string(),
  gitlabUrl: z.string(),
  authenticated: z.boolean(),
  truncated: z.boolean().describe(
    "True if the project listing hit the pagination page cap — the scan is partial",
  ),
  totalProjects: z.number().int().describe("Projects listed in the group"),
  scanned: z.number().int().describe("Projects that had a spec at the branch"),
  missingBranch: z.number().int().describe(
    "Projects with no spec at the branch (404)",
  ),
  unparsed: z.number().int().describe(
    "Scanned specs whose Version couldn't resolve",
  ),
  errors: z.number().int().describe("Projects that failed to fetch (non-404)"),
  unparsedPackages: z
    .array(z.object({ distgit: z.string(), rawLine: z.string().nullable() }))
    .describe("Unparsed specs with their raw Version line, for triage"),
  errorPackages: z
    .array(z.object({ distgit: z.string(), reason: z.string() }))
    .describe("Fetch failures (non-404), for triage"),
  fetchedAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A package fact as produced by {@link toPackageFact}. */
export interface PackageFact {
  distgit: string;
  projectId: number;
  branch: string;
  version: string | null;
  release: string | null;
  epoch: string | null;
  versionRaw: string | null;
  resolved: boolean;
  unresolvedReason?: string;
  /** Basenames of the spec's URL `Source*` lines (must live in the lookaside). */
  urlSources?: string[];
  /** Filenames pinned in the `sources` metadata file. */
  sourcesEntries?: string[];
}

/** Auth headers for a request — a PAT if configured, else none. */
export function authHeaders(token: string): Record<string, string> {
  return token ? { "PRIVATE-TOKEN": token } : {};
}

/** URL for one page of a group's projects (subgroups included, stable order). */
export function projectsPageUrl(
  gitlabUrl: string,
  group: string,
  page: number,
  perPage = 100,
): string {
  const base = gitlabUrl.replace(/\/+$/, "");
  const g = encodeURIComponent(group);
  return `${base}/api/v4/groups/${g}/projects?per_page=${perPage}&page=${page}` +
    `&include_subgroups=true&archived=false&order_by=path&sort=asc`;
}

/** URL for a project's raw `<name>.spec` at a branch. */
export function rawSpecUrl(
  gitlabUrl: string,
  projectId: number,
  distgit: string,
  branch: string,
): string {
  const base = gitlabUrl.replace(/\/+$/, "");
  const file = encodeURIComponent(`${distgit}.spec`);
  return `${base}/api/v4/projects/${projectId}/repository/files/${file}/raw` +
    `?ref=${encodeURIComponent(branch)}`;
}

/** URL for a project's raw `sources` metadata file at a branch. */
export function sourcesFileUrl(
  gitlabUrl: string,
  projectId: number,
  branch: string,
): string {
  const base = gitlabUrl.replace(/\/+$/, "");
  return `${base}/api/v4/projects/${projectId}/repository/files/sources/raw` +
    `?ref=${encodeURIComponent(branch)}`;
}

/**
 * Turn a {@link SpecVersion} into a persisted package fact for one project.
 *
 * @param distgit The distgit package name (project path).
 * @param projectId The GitLab project id.
 * @param branch The branch the spec was read from.
 * @param sv The resolved spec version.
 * @returns The package fact (with `unresolvedReason` only when unresolved).
 */
export function toPackageFact(
  distgit: string,
  projectId: number,
  branch: string,
  sv: SpecVersion,
  urlSources: string[] = [],
  sourcesEntries: string[] = [],
): PackageFact {
  const fact: PackageFact = {
    distgit,
    projectId,
    branch,
    version: sv.version,
    release: sv.release,
    epoch: sv.epoch,
    versionRaw: sv.versionRaw,
    resolved: sv.resolved,
    urlSources,
    sourcesEntries,
  };
  if (!sv.resolved && sv.unresolvedReason) {
    fact.unresolvedReason = sv.unresolvedReason;
  }
  return fact;
}

/** A GitLab project the scan cares about. */
export interface Project {
  id: number;
  path: string;
}

/**
 * Run `fn` over `items` with a bounded number of concurrent executions,
 * preserving input order in the result.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Fetch seam
// ---------------------------------------------------------------------------

/** A `fetch`-compatible function (injected in tests). */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET a URL with retry on transient rate-limit/unavailable responses,
 * honouring `Retry-After` (seconds) with a bounded default backoff.
 *
 * A thrown fetch (connection timeout, DNS failure, reset) is treated as a
 * retriable event too — the most common gitlab.com failure in practice, and
 * one that without retry would immediately land the package in the errors
 * bucket. After `maxRetries` failed attempts the original error is rethrown
 * so the caller's scanProjects catch-classifier can record it.
 *
 * ## Backoff regime (NEW-2)
 *
 * The backoff schedule is *monotonic* across the whole retry sequence: a
 * linear floor (1s, 2s, 3s…) advances on every retry, and a server-supplied
 * `Retry-After` that exceeds the current floor lifts it for subsequent steps
 * — so a 10s Retry-After followed by a thrown fetch waits at least 11s next,
 * not a reset to 1s. This prevents regime-switching where one failure mode
 * hands the sequence back to a tighter schedule after a server-driven pause.
 *
 * @returns The final response (which may still be non-ok, e.g. a 404).
 */
export async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  doFetch: FetchLike,
  maxRetries = 3,
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}> {
  let linearMs = 1000; // monotonic linear floor; advances every retry
  for (let attempt = 0;; attempt++) {
    let resp;
    try {
      resp = await doFetch(url, { headers });
    } catch (err) {
      // Thrown fetch (timeout/DNS/reset). Retry up to maxRetries with the
      // monotonic backoff; rethrow the last failure so the caller records it.
      if (attempt >= maxRetries) throw err;
      await sleep(linearMs);
      linearMs += 1000;
      continue;
    }
    // Retry rate-limits and any transient 5xx (a 500/502/504 mid-pagination
    // would otherwise abort the whole scan); a 404 is a definitive answer.
    const retriable = resp.status === 429 ||
      (resp.status >= 500 && resp.status < 600);
    if (!retriable) return resp;
    if (attempt >= maxRetries) return resp;
    const raHeader = resp.headers.get("retry-after");
    const ra = raHeader === null ? NaN : Number(raHeader);
    // Honour Retry-After, but cap it: a server-supplied value is untrusted and
    // an absurdly large one would otherwise stall the whole scan indefinitely.
    const waitMs = Number.isFinite(ra) && ra >= 0
      ? Math.min(ra * 1000, 60_000)
      : linearMs;
    // NEW-2: advance the linear floor past whichever wait we're about to take,
    // so the next step never drops below what we just used. A Retry-After of
    // 10s followed by a thrown fetch yields >=11s, not a reset to 1s.
    linearMs = Math.max(linearMs + 1000, waitMs + 1000);
    await sleep(waitMs);
  }
}

// ---------------------------------------------------------------------------
// Scan orchestration (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Strip URL-like sequences from an operator-facing error message.
 *
 * A thrown fetch's `.message` may embed the request URL (some wrappers append
 * it; a DNS error may quote the host). For error-packages triage the operator
 * needs the *reason* (timeout / reset / refused), not the URL — which is
 * already known from the distgit name + project id and would only clutter the
 * report. Replace any `http(s)://…` run with `<url>`.
 *
 * @param message An error message, possibly containing a URL.
 * @returns The message with any URL runs replaced.
 */
export function redactUrl(message: string): string {
  return message.replace(/https?:\/\/[^\s)'"]+/g, "<url>");
}

/** Minimal logging surface the methods rely on. */
interface MethodLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

/**
 * Hard cap on the number of pagination pages `listProjects` will follow before
 * giving up. The SIG group is large (hundreds of projects) but finite; a bound
 * here is a circuit breaker against a misbehaving server that keeps reporting
 * `x-next-page` forever (or an unbounded loop on a bug). Hitting the cap is a
 * warning — the scan proceeds with what it has, and the summary flags it —
 * rather than a silent stall on the whole workflow.
 *
 * 50 pages * 100 per-page = 5000 projects; far above what the Cloud SIG group
 * currently holds, well below what would stall a scan indefinitely.
 */
const MAX_PAGINATION_PAGES = 50;

/**
 * List every project in the group, paginating until GitLab reports no next
 * page (or `maxProjects` is reached).
 *
 * @param cfg Resolved global args.
 * @param doFetch Fetch implementation.
 * @param logger Logger.
 * @returns The projects (id + path), plus `truncated` if the page cap was hit.
 */
export async function listProjects(
  cfg: GlobalArgs,
  doFetch: FetchLike,
  logger: MethodLogger,
): Promise<{ projects: Project[]; truncated: boolean }> {
  const headers = authHeaders(cfg.token);
  const projects: Project[] = [];
  let truncated = false;
  for (let page = 1;; page++) {
    if (page > MAX_PAGINATION_PAGES) {
      // SR-2: hard cap — don't follow a misbehaving server into an infinite
      // pagination loop. Warn so a human notices; proceed with what we have.
      logger.warning(
        "Pagination reached the hard cap of {cap} pages ({count} projects); " +
          "stopping. The group may have more projects than were scanned.",
        { cap: MAX_PAGINATION_PAGES, count: projects.length },
      );
      truncated = true;
      break;
    }
    const url = projectsPageUrl(cfg.gitlabUrl, cfg.group, page);
    const resp = await fetchWithRetry(url, headers, doFetch);
    if (!resp.ok) {
      throw new Error(
        `Listing ${cfg.group} page ${page} failed (HTTP ${resp.status} ${resp.statusText})`,
      );
    }
    const batch = JSON.parse(await resp.text()) as Array<
      { id: number; path: string }
    >;
    for (const p of batch) {
      projects.push({ id: p.id, path: p.path });
      if (cfg.maxProjects > 0 && projects.length >= cfg.maxProjects) {
        return { projects, truncated };
      }
    }
    const next = resp.headers.get("x-next-page");
    if (!next) break;
  }
  logger.info("Listed {count} projects in {group}", {
    count: projects.length,
    group: cfg.group,
  });
  return { projects, truncated };
}

/** The buckets a scan produces before they become the two resources. */
export interface ScanResult {
  packages: PackageFact[];
  missingBranch: string[];
  errorPackages: Array<{ distgit: string; reason: string }>;
  totalProjects: number;
}

/**
 * Fetch and classify the spec for every project. A 404 means no spec at the
 * branch (→ `missingBranch`); any other non-2xx is an error; a 200 is resolved
 * with {@link resolveSpecVersion} into a package fact.
 *
 * @param cfg Resolved global args.
 * @param projects Projects to scan.
 * @param doFetch Fetch implementation.
 * @returns The classified buckets.
 */
export async function scanProjects(
  cfg: GlobalArgs,
  projects: Project[],
  doFetch: FetchLike,
): Promise<ScanResult> {
  const headers = authHeaders(cfg.token);
  const packages: PackageFact[] = [];
  const missingBranch: string[] = [];
  const errorPackages: Array<{ distgit: string; reason: string }> = [];

  await mapPool(projects, cfg.concurrency, async (p) => {
    const url = rawSpecUrl(cfg.gitlabUrl, p.id, p.path, cfg.branch);
    let resp;
    try {
      resp = await fetchWithRetry(url, headers, doFetch);
    } catch (e) {
      // NEW-3: redact any URL that the thrown error's message may embed —
      // the distgit name already identifies the package, and the operator
      // triaging errorPackages doesn't need to see the request URL.
      errorPackages.push({
        distgit: p.path,
        reason: `fetch threw: ${redactUrl((e as Error).message)}`,
      });
      return;
    }
    if (resp.status === 404) {
      missingBranch.push(p.path);
      return;
    }
    if (!resp.ok) {
      errorPackages.push({
        distgit: p.path,
        reason: `HTTP ${resp.status} ${resp.statusText}`,
      });
      return;
    }
    const specText = await resp.text();
    const sv = resolveSpecVersion(specText);
    const urlSources = urlSourceBasenames(specText);
    // Best-effort: the `sources` metadata file is often absent (RDO/DLRN
    // packages) — a 404 or any fetch failure means "no lookaside sources", not
    // a scan error, so it never derails the package fact.
    let sourcesEntries: string[] = [];
    try {
      const sr = await doFetch(
        sourcesFileUrl(cfg.gitlabUrl, p.id, cfg.branch),
        { headers },
      );
      if (sr.ok) sourcesEntries = parseSourcesFile(await sr.text());
    } catch {
      // leave sourcesEntries empty
    }
    packages.push(
      toPackageFact(p.path, p.id, cfg.branch, sv, urlSources, sourcesEntries),
    );
  });

  packages.sort((a, b) => a.distgit.localeCompare(b.distgit));
  missingBranch.sort();
  errorPackages.sort((a, b) => a.distgit.localeCompare(b.distgit));
  return {
    packages,
    missingBranch,
    errorPackages,
    totalProjects: projects.length,
  };
}

/** Reduce a {@link ScanResult} into the persisted `scan-summary` payload. */
export function buildScanSummary(
  cfg: GlobalArgs,
  result: ScanResult,
  truncated: boolean,
): z.infer<typeof ScanSummarySchema> {
  const unparsedPackages = result.packages
    .filter((p) => !p.resolved)
    .map((p) => ({ distgit: p.distgit, rawLine: p.versionRaw }));
  return {
    branch: cfg.branch,
    group: cfg.group,
    gitlabUrl: cfg.gitlabUrl,
    authenticated: !!cfg.token,
    truncated,
    totalProjects: result.totalProjects,
    scanned: result.packages.length,
    missingBranch: result.missingBranch.length,
    unparsed: unparsedPackages.length,
    errors: result.errorPackages.length,
    unparsedPackages,
    errorPackages: result.errorPackages,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Minimal shape of the execute context this model relies on. */
interface ExecuteContext {
  globalArgs: GlobalArgs;
  logger: MethodLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Return shape for every method's execute function. */
interface ExecuteResult {
  dataHandles: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Read-only CentOS Cloud SIG distgit scan model. */
export const model = {
  type: "@kneel/sig-distgit",
  version: "2026.09.29.1",
  description:
    "Read-only fan-out scan of a CentOS Cloud SIG distgit group on gitlab.com: " +
    "lists every project, fetches each <name>.spec at a branch, resolves its " +
    "Version/Release/Epoch (expanding %global macros), and persists per-package " +
    "facts plus a scan-summary (scanned / missing-branch / unparsed counts).",
  globalArguments: GlobalArgsSchema,
  resources: {
    "packages": {
      description: "Per-package resolved spec facts at the scanned branch",
      schema: PackagesSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "scan-summary": {
      description:
        "Headline counts + triage lists (unparsed, errors) for one scan",
      schema: ScanSummarySchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    scan: {
      description:
        "Fan-out scan of the whole group in one execution: paginate projects, " +
        "fetch each <name>.spec at the branch (bounded concurrency, optional " +
        "PAT), resolve versions, and persist `packages` + `scan-summary`.",
      arguments: z.object({}),
      execute: async (
        args: { _fetch?: FetchLike },
        context: ExecuteContext,
      ): Promise<ExecuteResult> => {
        const cfg = context.globalArgs;
        const doFetch = args._fetch ?? (fetch as unknown as FetchLike);
        const { projects, truncated } = await listProjects(
          cfg,
          doFetch,
          context.logger,
        );
        const result = await scanProjects(cfg, projects, doFetch);
        const summary = buildScanSummary(cfg, result, truncated);
        if (truncated) {
          context.logger.warning(
            "Project listing hit the page cap ({cap}) — scan-summary.truncated=true, results are partial",
            { cap: MAX_PAGINATION_PAGES },
          );
        }
        context.logger.info(
          "Scanned {scanned}/{total}: {missing} missing-branch, {unparsed} unparsed, {errors} errors",
          {
            scanned: summary.scanned,
            total: summary.totalProjects,
            missing: summary.missingBranch,
            unparsed: summary.unparsed,
            errors: summary.errors,
          },
        );

        const h1 = await context.writeResource("packages", "packages", {
          branch: cfg.branch,
          group: cfg.group,
          scanned: result.packages.length,
          packages: result.packages,
          fetchedAt: summary.fetchedAt,
        });
        const h2 = await context.writeResource(
          "scan-summary",
          "scan-summary",
          summary,
        );
        return { dataHandles: [h1, h2] };
      },
    },
  },
};
