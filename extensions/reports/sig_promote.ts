/**
 * Workflow-scope report: the SIG package promotion matrix.
 *
 * Joins three snapshots to show, for every package, where it sits in the CBS
 * candidate → testing → release pipeline and what the next action is:
 *
 *  - koji `promotion` — the per-package latest NVR in each of the three
 *    promotion tags (produced by `@kneel/koji.promotion_matrix`, a single
 *    `multicall` fan-out; until that method lands the same shape can be
 *    assembled from three `latest_builds` reads — see `sig_promote_html.ts`).
 *  - `@kneel/sig-distgit` `packages` — the dist-git spec EVR at the SIG branch.
 *  - `@kneel/openstack-releases` `deliverables` — the upstream target version.
 *
 * Per package it derives a primary {@link PromoStatus} (most-actionable first)
 * and the concrete `cbs` command to advance it:
 *
 *  - **unbuilt**        — dist-git newer than any built tag → a build is owed.
 *  - **promote-testing**— candidate newer than testing  → `cbs tag-build …-testing`.
 *  - **promote-release**— testing newer than release    → `cbs tag-build …-release`.
 *  - **behind-upstream**— dist-git older than upstream  → a spec bump (not a CBS op).
 *  - **ahead**          — release newer than dist-git   → anomaly to review.
 *  - **current**        — release == testing == candidate == dist-git.
 *  - **unknown**        — no koji build in any tag.
 *
 * All version math is EVR-correct ({@link evrCompare} — epoch dominates, then
 * version, then release), reusing the same tested library the epoxy-gap report
 * uses. The compute + render functions are pure so they unit-test against live
 * NVR fixtures with no I/O.
 *
 * A workflow-scope report (like `epoxy-gap`) because the join needs all three
 * models' data at once; attach it via a workflow's `reports.require`.
 *
 * @module
 */
import { buildIndex, mapName } from "../lib/name_map.ts";
import { type EVR, evrCompare, rpmvercmp } from "../lib/rpmvercmp.ts";
import { classifySources, type SourcesStatus } from "../lib/spec_sources.ts";
import type { PackageFact } from "../models/sig_distgit.ts";

/**
 * Upstream deliverable shape, mirroring `@kneel/openstack-releases`'s
 * `DeliverableEntry` (declared locally so this report bundles with
 * `@kneel/sig-distgit` without a cross-extension source import — the data still
 * arrives at runtime from the openstack-releases model's `deliverables`).
 */
interface DeliverableEntry {
  deliverable: string;
  latestVersion: string | null;
  latestVersionSource: "vercmp-max" | "none";
  fileOrderVersion: string | null;
  repos: string[];
  releaseCount: number;
  series: "epoxy" | "independent";
}

/**
 * Strip control chars and markdown-structural characters from a cell value so
 * package/deliverable names can't break out of the inline-code spans or table
 * cells the renderer wraps them in. Inlined (rather than shared from another
 * report) so this report is self-contained in its bundle.
 */
function sanitizeMarkdown(s: string, inTable = false): string {
  // deno-lint-ignore no-control-regex -- deliberately strips C0/C1 control chars
  let out = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  out = out.replace(/`/g, "");
  out = out.replace(/^([#\-+>`|])/gm, "\\$1");
  if (inTable) {
    out = out.replace(/\|/g, "\\|");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** One build occupying a promotion tag (from `getLatestBuilds`). */
export interface PromoLevel {
  nvr: string;
  version?: string | null;
  release?: string | null;
  epoch?: string | number | null;
  build_id?: number;
  state?: string;
}

/** The koji `promotion` snapshot: per-package NVR in each promotion tag. */
export interface PromotionMatrix {
  tags: {
    candidate: string;
    testing: string;
    release: string;
    /** The build target builds are submitted to (dest_tag == candidate). */
    buildTarget?: string;
  };
  packages: Record<string, {
    candidate?: PromoLevel | null;
    testing?: PromoLevel | null;
    release?: PromoLevel | null;
  }>;
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** A package's primary state in the pipeline — most-actionable first. */
export type PromoStatus =
  | "unbuilt"
  | "promote-testing"
  | "promote-release"
  | "behind-upstream"
  | "ahead"
  | "current"
  | "unknown";

/** Sort priority — the actionable statuses surface first. */
const STATUS_RANK: Record<PromoStatus, number> = {
  unbuilt: 0,
  "promote-testing": 1,
  "promote-release": 2,
  "behind-upstream": 3,
  ahead: 4,
  current: 5,
  unknown: 6,
};

/** One row of the promotion matrix. */
export interface PromoRow {
  package: string;
  /** Upstream target version (null when unmapped / no upstream release). */
  upstream: string | null;
  /** Dist-git spec version-release (null when unscanned / unparsed). */
  distgit: string | null;
  /** Latest NVR in each promotion tag (null when the package isn't tagged). */
  candidate: string | null;
  testing: string | null;
  release: string | null;
  status: PromoStatus;
  /** Independent (orthogonal) signals — a package can raise several. */
  buildOwed: boolean;
  promotableTesting: boolean;
  promotableRelease: boolean;
  behindUpstream: boolean;
  /**
   * Whether the dist-git `sources` file matches the spec's URL sources — the
   * readiness of a native `cbs build git+https`. `partial`/`stale` are real bugs
   * (a bump that didn't re-stage sources — the keystone failure mode); `none` is
   * the normal RDO/DLRN state (informational).
   */
  sourcesStatus: SourcesStatus;
  /** The concrete next command (cbs), or null when nothing to do. */
  nextAction: string | null;
}

/** Headline counts across the matrix. */
export interface PromoSummary {
  tags: PromotionMatrix["tags"];
  total: number;
  unbuilt: number;
  promoteTesting: number;
  promoteRelease: number;
  behindUpstream: number;
  ahead: number;
  current: number;
  unknown: number;
  /** unbuilt + promote-testing + promote-release — the CBS work queue. */
  actionable: number;
  /** `sources` file is stale (tarball version != spec) — a bump bug. */
  sourcesStale: number;
  /** `sources` file has fewer entries than the spec's URL sources — a bump bug. */
  sourcesPartial: number;
}

/** The full computed matrix: rows + summary. */
export interface PromoReport {
  rows: PromoRow[];
  summary: PromoSummary;
}

// ---------------------------------------------------------------------------
// EVR helpers
// ---------------------------------------------------------------------------

/** Split an NVR into `{name, version, release}` (release = after last `-`). */
export function parseNvr(
  nvr: string,
): { name: string; version: string; release: string } | null {
  const i = nvr.lastIndexOf("-");
  if (i <= 0) return null;
  const j = nvr.lastIndexOf("-", i - 1);
  if (j <= 0) return null;
  return {
    name: nvr.slice(0, j),
    version: nvr.slice(j + 1, i),
    release: nvr.slice(i + 1),
  };
}

/** EVR for a koji level — prefer explicit fields, else parse the NVR string. */
function levelEvr(level: PromoLevel | null | undefined): EVR | null {
  if (!level) return null;
  if (level.version) {
    return {
      epoch: level.epoch ?? null,
      version: level.version,
      release: level.release ?? null,
    };
  }
  const p = parseNvr(level.nvr);
  return p
    ? { epoch: level.epoch ?? null, version: p.version, release: p.release }
    : null;
}

/** EVR for a dist-git fact (version + release + epoch from the spec). */
function distgitEvr(fact: PackageFact | undefined): EVR | null {
  if (!fact || !fact.resolved || fact.version === null) return null;
  return { epoch: fact.epoch, version: fact.version, release: fact.release };
}

/** Human EVR string: `[epoch:]version[-release]`. */
function evrStr(evr: EVR | null): string | null {
  if (!evr) return null;
  const e = evr.epoch !== null && evr.epoch !== undefined && evr.epoch !== "" &&
      String(evr.epoch) !== "0"
    ? `${evr.epoch}:`
    : "";
  return `${e}${evr.version}${evr.release ? `-${evr.release}` : ""}`;
}

// ---------------------------------------------------------------------------
// Compute (pure)
// ---------------------------------------------------------------------------

/**
 * Decide one package's row from its koji levels + optional dist-git / upstream.
 *
 * Primary status is chosen by CBS actionability (build owed > promote-testing >
 * promote-release), then non-CBS signals (behind-upstream, ahead), then current.
 * The orthogonal booleans are all reported so a package that is e.g. both
 * promotable-to-testing and behind-upstream is fully described.
 */
export function rowFor(
  pkg: string,
  levels: {
    candidate?: PromoLevel | null;
    testing?: PromoLevel | null;
    release?: PromoLevel | null;
  },
  tags: PromotionMatrix["tags"],
  distgit: PackageFact | undefined,
  upstream: string | null,
): PromoRow {
  const c = levelEvr(levels.candidate);
  const t = levelEvr(levels.testing);
  const r = levelEvr(levels.release);
  const d = distgitEvr(distgit);

  // Three comparison contexts, because the operands aren't uniformly comparable:
  //  - tag↔tag (candidate/testing/release): full EVR — all koji builds carry
  //    the same `.el9s` dist tag, so release is meaningfully comparable.
  //  - dist-git↔koji: epoch+version only. The scanned spec `Release:` is `1`
  //    (the `%{?dist}` macro isn't expanded) while the koji build is `1.el9s`,
  //    so comparing release would spuriously rank the koji build newer.
  //  - dist-git↔upstream: version only. A downstream `Epoch:` is packaging
  //    metadata and must never invert the upstream comparison (per epoxy-gap).
  const evCmp = (a: EVR, b: EVR) =>
    evrCompare({ epoch: a.epoch, version: a.version }, {
      epoch: b.epoch,
      version: b.version,
    });

  // Build owed: dist-git's version newer than the newest build in ANY tag (or
  // never built anywhere). Comparing against candidate alone is wrong when a
  // stale older build lingers in candidate while the current one already sits
  // in testing/release — that version is built, so no build is owed.
  const builtMax = [c, t, r].filter((x): x is EVR => x !== null)
    .reduce<EVR | null>(
      (m, x) => (m === null || evrCompare(x, m) > 0 ? x : m),
      null,
    );
  const buildOwed = d !== null && (builtMax === null || evCmp(d, builtMax) > 0);
  // Promotable: a strictly-newer build sits one level down (full EVR, koji↔koji).
  const promotableTesting = c !== null && (t === null || evrCompare(c, t) > 0);
  const promotableRelease = t !== null && (r === null || evrCompare(t, r) > 0);
  const behindUpstream = d !== null && upstream !== null &&
    rpmvercmp(d.version, upstream) < 0;
  const ahead = d !== null && r !== null && evCmp(r, d) > 0;

  let status: PromoStatus;
  if (buildOwed) status = "unbuilt";
  else if (promotableTesting) status = "promote-testing";
  else if (promotableRelease) status = "promote-release";
  else if (behindUpstream) status = "behind-upstream";
  else if (ahead) status = "ahead";
  else if (c === null && t === null && r === null) status = "unknown";
  else status = "current";

  const sourcesStatus: SourcesStatus = distgit
    ? classifySources(
      distgit.urlSources ?? [],
      distgit.sourcesEntries ?? [],
      distgit.version,
    )
    : "complete";

  const target = tags.buildTarget ?? "<build-target>";
  let nextAction: string | null = null;
  if (status === "unbuilt") {
    nextAction = sourcesStatus === "partial" || sourcesStatus === "stale"
      ? `stage sources first (${sourcesStatus}: \`sources\` doesn't match spec) — then cbs build`
      : `cbs build ${target} git+https://gitlab.com/CentOS/cloud/rpms/${pkg}.git#<sha>`;
  } else if (status === "promote-testing") {
    nextAction = `cbs tag-build ${tags.testing} ${levels.candidate!.nvr}`;
  } else if (status === "promote-release") {
    nextAction = `cbs tag-build ${tags.release} ${levels.testing!.nvr}`;
  }

  return {
    package: pkg,
    upstream,
    distgit: evrStr(d),
    candidate: levels.candidate?.nvr ?? null,
    testing: levels.testing?.nvr ?? null,
    release: levels.release?.nvr ?? null,
    status,
    buildOwed,
    promotableTesting,
    promotableRelease,
    behindUpstream,
    sourcesStatus,
    nextAction,
  };
}

/**
 * Join the koji promotion matrix with dist-git facts and upstream deliverables
 * into the promotion table. Pure — no I/O — so it is fully unit-testable.
 *
 * @param matrix The koji `promotion` snapshot (per-package per-tag NVRs).
 * @param packages Dist-git package facts (`sig-distgit.packages`) — optional;
 *   an empty list simply leaves the dist-git/upstream columns null.
 * @param deliverables Upstream deliverables (`openstack-releases`) — optional.
 */
export function computePromotion(
  matrix: PromotionMatrix,
  packages: PackageFact[] = [],
  deliverables: DeliverableEntry[] = [],
): PromoReport {
  const factByName = new Map(packages.map((p) => [p.distgit, p]));
  const idx = buildIndex(
    deliverables.map((d) => ({ deliverable: d.deliverable, repos: d.repos })),
  );
  const latestByDeliverable = new Map(
    deliverables.map((d) => [d.deliverable, d.latestVersion]),
  );

  const upstreamFor = (pkg: string): string | null => {
    if (deliverables.length === 0) return null;
    const m = mapName(pkg, idx);
    if ("unmatched" in m) return null;
    return latestByDeliverable.get(m.deliverable) ?? null;
  };

  const rows = Object.entries(matrix.packages).map(([pkg, levels]) =>
    rowFor(pkg, levels, matrix.tags, factByName.get(pkg), upstreamFor(pkg))
  );
  rows.sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.package.localeCompare(b.package)
  );

  const count = (s: PromoStatus) => rows.filter((r) => r.status === s).length;
  const summary: PromoSummary = {
    tags: matrix.tags,
    total: rows.length,
    unbuilt: count("unbuilt"),
    promoteTesting: count("promote-testing"),
    promoteRelease: count("promote-release"),
    behindUpstream: count("behind-upstream"),
    ahead: count("ahead"),
    current: count("current"),
    unknown: count("unknown"),
    actionable: count("unbuilt") + count("promote-testing") +
      count("promote-release"),
    sourcesStale: rows.filter((r) => r.sourcesStatus === "stale").length,
    sourcesPartial: rows.filter((r) => r.sourcesStatus === "partial").length,
  };
  return { rows, summary };
}

// ---------------------------------------------------------------------------
// Render — markdown
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<PromoStatus, string> = {
  unbuilt: "🔨 build owed",
  "promote-testing": "⬆️ → testing",
  "promote-release": "⬆️ → release",
  "behind-upstream": "📦 bump spec",
  ahead: "⚠️ ahead",
  current: "✅ current",
  unknown: "· no build",
};

/** Render the promotion matrix as a markdown briefing. */
export function renderMarkdown(rep: PromoReport): string {
  const s = rep.summary;
  const L: string[] = [];
  L.push(
    `# SIG promotion — \`${
      sanitizeMarkdown(s.tags.candidate.replace(/-candidate$/, ""))
    }\``,
    "",
  );
  L.push(
    `- **${s.total} packages** · **${s.actionable} actionable** ` +
      `(${s.unbuilt} to build · ${s.promoteTesting} → testing · ${s.promoteRelease} → release)`,
    `- ${s.current} current · ${s.behindUpstream} behind upstream · ${s.ahead} ahead · ${s.unknown} no build`,
    ...(s.sourcesStale + s.sourcesPartial > 0
      ? [
        `- ⚠️ **${s.sourcesStale + s.sourcesPartial} sources issue(s)** ` +
        `(${s.sourcesStale} stale · ${s.sourcesPartial} partial) — would fail \`buildSRPMFromSCM\``,
      ]
      : []),
    "",
  );

  const actionRows = rep.rows.filter((r) =>
    r.status === "unbuilt" || r.status === "promote-testing" ||
    r.status === "promote-release"
  );
  L.push(`## Action queue (${actionRows.length})`, "");
  if (actionRows.length === 0) {
    L.push("_Nothing to build or promote — the pipeline is settled._", "");
  } else {
    L.push(
      "| Package | Status | From → To | Next command |",
      "| --- | --- | --- | --- |",
    );
    for (const r of actionRows) {
      const fromTo = r.status === "unbuilt"
        ? `${sanitizeMarkdown(r.distgit ?? "?", true)} → candidate`
        : r.status === "promote-testing"
        ? `${sanitizeMarkdown(r.candidate ?? "?", true)} → testing`
        : `${sanitizeMarkdown(r.testing ?? "?", true)} → release`;
      L.push(
        `| ${sanitizeMarkdown(r.package, true)} | ${
          STATUS_LABEL[r.status]
        } | ${fromTo} | ` +
          `\`${sanitizeMarkdown(r.nextAction ?? "", true)}\` |`,
      );
    }
    L.push("");
  }

  // Sources-staging bugs (a spec bump that didn't re-stage the `sources` file).
  // Cross-cuts promotion status, so it gets its own section — these block a
  // native `cbs build git+https` before it even starts (the keystone failure).
  const srcRows = rep.rows.filter((r) =>
    r.sourcesStatus === "stale" || r.sourcesStatus === "partial"
  );
  if (srcRows.length > 0) {
    L.push(`## Sources staging needed (${srcRows.length})`, "");
    L.push(
      "_Spec references URL sources the `sources` file doesn't match — a version " +
        "bump that didn't re-stage the lookaside metadata. Fix with " +
        "`centos-lookaside-upload-sig` + a complete `sources` file before building._",
      "",
      "| Package | Issue | dist-git |",
      "| --- | --- | --- |",
    );
    for (const r of srcRows) {
      L.push(
        `| ${sanitizeMarkdown(r.package, true)} | ${r.sourcesStatus} | ${
          sanitizeMarkdown(r.distgit ?? "—", true)
        } |`,
      );
    }
    L.push("");
  }

  L.push("## Full matrix", "");
  L.push(
    "| Package | upstream | dist-git | candidate | testing | release | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of rep.rows) {
    L.push(
      `| ${sanitizeMarkdown(r.package, true)} | ${
        sanitizeMarkdown(r.upstream ?? "—", true)
      } | ` +
        `${sanitizeMarkdown(r.distgit ?? "—", true)} | ${
          sanitizeMarkdown(r.candidate ?? "—", true)
        } | ` +
        `${sanitizeMarkdown(r.testing ?? "—", true)} | ${
          sanitizeMarkdown(r.release ?? "—", true)
        } | ` +
        `${STATUS_LABEL[r.status]} |`,
    );
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Render — self-contained, theme-aware HTML
// ---------------------------------------------------------------------------

const STATUS_CLASS: Record<PromoStatus, string> = {
  unbuilt: "s-build",
  "promote-testing": "s-test",
  "promote-release": "s-rel",
  "behind-upstream": "s-bump",
  ahead: "s-ahead",
  current: "s-ok",
  unknown: "s-none",
};

/** Minimal HTML-escape for text nodes and attributes. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (
      c,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]!),
  );
}

const td = (v: string | null) =>
  `<td>${v ? esc(v) : "<span class=dim>—</span>"}</td>`;

/**
 * Render the promotion matrix as a self-contained, theme-aware HTML dashboard
 * (inlined CSS, no external assets — pastes into an Artifact or opens locally).
 */
export function renderHtml(rep: PromoReport): string {
  const s = rep.summary;
  const scope = s.tags.candidate.replace(/-candidate$/, "");
  const chip = (n: number, label: string, cls: string) =>
    `<span class="chip ${cls}"><b>${n}</b> ${esc(label)}</span>`;
  const srcBadge = (r: PromoRow) =>
    r.sourcesStatus === "stale" || r.sourcesStatus === "partial"
      ? ` <span class="badge" title="sources ${r.sourcesStatus} — would fail buildSRPMFromSCM">src:${r.sourcesStatus}</span>`
      : "";
  const bodyRows = rep.rows.map((r) =>
    `<tr class="${STATUS_CLASS[r.status]}">` +
    `<td class=pkg>${esc(r.package)}${srcBadge(r)}</td>` +
    td(r.upstream) + td(r.distgit) + td(r.candidate) + td(r.testing) +
    td(r.release) +
    `<td class=st>${esc(STATUS_LABEL[r.status])}</td>` +
    `<td class=act>${
      r.nextAction
        ? `<code>${esc(r.nextAction)}</code>`
        : "<span class=dim>—</span>"
    }</td>` +
    `</tr>`
  ).join("\n");

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>SIG promotion — ${esc(scope)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--dim:#8a8a8a;--line:#e3e3e3;--row:#fafafa;--code:#f4f4f5;
--build:#b45309;--test:#1d4ed8;--rel:#7c3aed;--bump:#a16207;--ahead:#b91c1c;--ok:#15803d;--none:#71717a;}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0f;--fg:#e8e8ea;--dim:#7a7a82;--line:#26262b;--row:#141417;--code:#1c1c20;
--build:#f59e0b;--test:#60a5fa;--rel:#c084fc;--bump:#eab308;--ahead:#f87171;--ok:#4ade80;--none:#a1a1aa;}}
:root[data-theme=dark]{--bg:#0d0d0f;--fg:#e8e8ea;--dim:#7a7a82;--line:#26262b;--row:#141417;--code:#1c1c20;
--build:#f59e0b;--test:#60a5fa;--rel:#c084fc;--bump:#eab308;--ahead:#f87171;--ok:#4ade80;--none:#a1a1aa;}
:root[data-theme=light]{--bg:#fff;--fg:#1a1a1a;--dim:#8a8a8a;--line:#e3e3e3;--row:#fafafa;--code:#f4f4f5;
--build:#b45309;--test:#1d4ed8;--rel:#7c3aed;--bump:#a16207;--ahead:#b91c1c;--ok:#15803d;--none:#71717a;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem 1.25rem}
.wrap{max-width:1100px;margin:0 auto}h1{font-size:1.35rem;margin:0 0 .25rem}
.sub{color:var(--dim);margin:0 0 1rem;font-size:.85rem}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1.25rem}
.chip{border:1px solid var(--line);border-radius:999px;padding:.15rem .6rem;font-size:.8rem}
.chip b{font-variant-numeric:tabular-nums}
.chip.s-build{color:var(--build)}.chip.s-test{color:var(--test)}.chip.s-rel{color:var(--rel)}
.chip.s-ok{color:var(--ok)}.chip.s-bump{color:var(--bump)}.chip.s-ahead{color:var(--ahead)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.82rem}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap}
th{position:sticky;top:0;background:var(--bg);font-weight:600;color:var(--dim);font-size:.72rem;
text-transform:uppercase;letter-spacing:.04em}
tbody tr:nth-child(2n){background:var(--row)}
td.pkg{font-weight:600}td.st{font-weight:600}
.act code,td code{background:var(--code);padding:.1rem .35rem;border-radius:5px;font-size:.76rem;white-space:pre}
.dim{color:var(--dim)}
tr.s-build td.st{color:var(--build)}tr.s-test td.st{color:var(--test)}tr.s-rel td.st{color:var(--rel)}
tr.s-bump td.st{color:var(--bump)}tr.s-ahead td.st{color:var(--ahead)}tr.s-ok td.st{color:var(--ok)}
tr.s-none td.st{color:var(--none)}
tr.s-build td.pkg,tr.s-test td.pkg,tr.s-rel td.pkg{border-left:3px solid currentColor}
.badge{font-size:.62rem;font-weight:600;color:var(--ahead);border:1px solid var(--ahead);
border-radius:4px;padding:0 .25rem;vertical-align:middle;white-space:nowrap}
footer{color:var(--dim);font-size:.72rem;margin-top:1rem}
</style></head><body><div class=wrap>
<h1>SIG promotion — ${esc(scope)}</h1>
<p class=sub>${s.total} packages · candidate → testing → release${
    s.tags.buildTarget
      ? ` · target <code>${esc(s.tags.buildTarget)}</code>`
      : ""
  }</p>
<div class=chips>
${chip(s.actionable, "actionable", "s-build")}
${chip(s.unbuilt, "build owed", "s-build")}
${chip(s.promoteTesting, "→ testing", "s-test")}
${chip(s.promoteRelease, "→ release", "s-rel")}
${chip(s.behindUpstream, "bump spec", "s-bump")}
${chip(s.ahead, "ahead", "s-ahead")}
${chip(s.current, "current", "s-ok")}
${
    s.sourcesStale + s.sourcesPartial > 0
      ? chip(s.sourcesStale + s.sourcesPartial, "sources issue", "s-ahead")
      : ""
  }
</div>
<div class=scroll><table>
<thead><tr><th>Package</th><th>upstream</th><th>dist-git</th><th>candidate</th><th>testing</th><th>release</th><th>status</th><th>next command</th></tr></thead>
<tbody>
${bodyRows}
</tbody></table></div>
<footer>Generated ${esc(rep.summary.tags.candidate)} · sig-promote${
    rep.rows.length ? "" : " · (no data)"
  }</footer>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Report wiring (workflow scope)
// ---------------------------------------------------------------------------

interface StepExecution {
  modelType: string;
  modelId: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: Array<{ name: string; version?: number }>;
}

/** Minimal workflow-scope report context (same shape epoxy-gap relies on). */
export interface WorkflowReportContext {
  stepExecutions: StepExecution[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger?: {
    info: (m: string, p?: Record<string, unknown>) => void;
    warning: (m: string, p?: Record<string, unknown>) => void;
  };
}

const KOJI_TYPE = "@kneel/koji";
const DISTGIT_TYPE = "@kneel/sig-distgit";
const RELEASES_TYPE = "@kneel/openstack-releases";

/**
 * A koji `latest_builds` output snapshot (dataName `tagged`, `method: "latest"`).
 * The snapshot self-identifies its `tag`, so the report can bucket builds into
 * the promotion ladder without needing the step's inputs.
 */
interface TaggedSnapshot {
  tag: string;
  method?: string;
  retrievedAt?: string;
  builds: Array<{
    package_name: string;
    nvr: string;
    version: string;
    release: string;
    epoch: number | null;
  }>;
}

/**
 * Classify a koji tag by the CentOS SIG promotion-ladder suffix. This is the one
 * piece of SIG-specific promotion semantics — it lives HERE in the SIG report,
 * not in the generic @kneel/koji model (koji has no concept of a promotion
 * ladder; it only lists builds per tag).
 */
function promotionLevel(
  tag: string,
): "candidate" | "testing" | "release" | null {
  if (tag.endsWith("-candidate")) return "candidate";
  if (tag.endsWith("-testing")) return "testing";
  if (tag.endsWith("-release")) return "release";
  return null;
}

async function readStepResource<T>(
  ctx: WorkflowReportContext,
  step: StepExecution,
  dataName: string,
): Promise<T | null> {
  const handle = step.dataHandles.find((h) => h.name === dataName);
  const bytes = await ctx.dataRepository.getContent(
    step.modelType,
    step.modelId,
    dataName,
    handle?.version,
  );
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function missing(
  reason: string,
): { markdown: string; json: Record<string, unknown> } {
  return {
    markdown: `_SIG promotion report unavailable: ${reason}._`,
    json: { error: true, reason },
  };
}

/** The SIG promotion report. */
export const report = {
  name: "@kneel/sig-distgit/sig-promote",
  description:
    "Join the koji promotion-tag NVRs with the SIG dist-git spec versions and " +
    "upstream releases into a per-package candidate→testing→release matrix with a " +
    "build/promote action queue.",
  scope: "workflow" as const,
  labels: ["fedora", "centos", "sig", "koji", "promotion"],
  execute: async (
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    // Build the promotion matrix in-report by joining the workflow's
    // `latest_builds` snapshots (one per promotion tag). The koji model stays
    // generic — it only lists builds per tag; the "these three tags form a
    // candidate→testing→release ladder" semantics live here in the SIG report.
    const kojiSteps = context.stepExecutions.filter((s) =>
      s.modelType === KOJI_TYPE && s.methodName === "latest_builds"
    );
    if (kojiSteps.length === 0) {
      return missing(
        `no ${KOJI_TYPE} latest_builds step in this workflow run — sig-detect ` +
          `must run latest_builds for the candidate/testing/release tags`,
      );
    }

    const packages: PromotionMatrix["packages"] = {};
    const tags = { candidate: "", testing: "", release: "" };
    let generatedAt: string | undefined;
    for (const step of kojiSteps) {
      const snap = await readStepResource<TaggedSnapshot>(
        context,
        step,
        "tagged",
      );
      if (!snap?.tag || !Array.isArray(snap.builds)) continue;
      const level = promotionLevel(snap.tag);
      if (!level) continue;
      tags[level] = snap.tag;
      generatedAt = snap.retrievedAt ?? generatedAt;
      for (const b of snap.builds) {
        if (!b?.package_name) continue;
        (packages[b.package_name] ??= {})[level] = {
          nvr: b.nvr,
          version: b.version,
          release: b.release,
          epoch: b.epoch ?? null,
        };
      }
    }
    if (!tags.candidate && !tags.testing && !tags.release) {
      return missing(
        `${KOJI_TYPE} latest_builds ran but produced no candidate/testing/` +
          `release snapshots (promotion tags must end in ` +
          `-candidate/-testing/-release)`,
      );
    }
    const matrix: PromotionMatrix = { tags, packages, generatedAt };

    const distgitStep = context.stepExecutions.find((s) =>
      s.modelType === DISTGIT_TYPE
    );
    const releasesStep = context.stepExecutions.find((s) =>
      s.modelType === RELEASES_TYPE
    );
    const packagesData = distgitStep
      ? await readStepResource<{ packages: PackageFact[] }>(
        context,
        distgitStep,
        "packages",
      )
      : null;
    const deliverablesData = releasesStep
      ? await readStepResource<{ deliverables: DeliverableEntry[] }>(
        context,
        releasesStep,
        "deliverables",
      )
      : null;

    const rep = computePromotion(
      matrix,
      packagesData?.packages ?? [],
      deliverablesData?.deliverables ?? [],
    );
    context.logger?.info?.(
      "SIG promote: {actionable} actionable ({unbuilt} build, {testing} testing, {release} release)",
      {
        actionable: rep.summary.actionable,
        unbuilt: rep.summary.unbuilt,
        testing: rep.summary.promoteTesting,
        release: rep.summary.promoteRelease,
      },
    );

    return {
      markdown: renderMarkdown(rep),
      json: {
        summary: rep.summary,
        rows: rep.rows,
        generatedAt: matrix.generatedAt ?? null,
      },
    };
  },
};
