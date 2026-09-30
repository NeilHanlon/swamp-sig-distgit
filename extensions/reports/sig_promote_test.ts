/**
 * Tests for the SIG promotion report — pure compute + render, no I/O.
 *
 * The keystone fixtures are the REAL live state read from cbs.centos.org on
 * 2026-08-04 (candidate carries an old RC; testing == release at 27.0.0-1), so
 * the derivation is validated against production data, not invented numbers.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  computePromotion,
  parseNvr,
  type PromotionMatrix,
  renderHtml,
  renderMarkdown,
  rowFor,
} from "./sig_promote.ts";
import type { PackageFact } from "../models/sig_distgit.ts";

const TAGS = {
  candidate: "cloud9s-openstack-epoxy-candidate",
  testing: "cloud9s-openstack-epoxy-testing",
  release: "cloud9s-openstack-epoxy-release",
  buildTarget: "cloud9s-openstack-epoxy-el9s",
};

const fact = (
  name: string,
  version: string,
  release = "1.el9s",
): PackageFact => ({
  distgit: name,
  projectId: 1,
  branch: "c9s-sig-cloud-epoxy",
  version,
  release,
  epoch: null,
  versionRaw: version,
  resolved: true,
});

Deno.test("parseNvr splits name/version/release", () => {
  assertEquals(parseNvr("openstack-keystone-27.0.2-1.el9s"), {
    name: "openstack-keystone",
    version: "27.0.2",
    release: "1.el9s",
  });
  assertEquals(
    parseNvr("openstack-keystone-27.0.0-0.1.0rc1.el9s")?.release,
    "0.1.0rc1.el9s",
  );
  assertEquals(parseNvr("nodashes"), null);
});

Deno.test("live keystone state → current (stale RC in candidate is not an action)", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-keystone": {
        candidate: { nvr: "openstack-keystone-27.0.0-0.1.0rc1.el9s" },
        testing: { nvr: "openstack-keystone-27.0.0-1.el9s" },
        release: { nvr: "openstack-keystone-27.0.0-1.el9s" },
      },
    },
  };
  const { rows, summary } = computePromotion(matrix);
  assertEquals(rows[0].status, "current");
  assertEquals(rows[0].nextAction, null);
  assertEquals(summary.actionable, 0);
});

Deno.test("after the 27.0.2 build lands → promote-testing with the exact cbs command", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-keystone": {
        candidate: { nvr: "openstack-keystone-27.0.2-1.el9s" },
        testing: { nvr: "openstack-keystone-27.0.0-1.el9s" },
        release: { nvr: "openstack-keystone-27.0.0-1.el9s" },
      },
    },
  };
  const { rows, summary } = computePromotion(matrix);
  assertEquals(rows[0].status, "promote-testing");
  assert(rows[0].promotableTesting);
  assertEquals(
    rows[0].nextAction,
    "cbs tag-build cloud9s-openstack-epoxy-testing openstack-keystone-27.0.2-1.el9s",
  );
  assertEquals(summary.promoteTesting, 1);
});

Deno.test("testing ahead of release → promote-release", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      p: {
        candidate: { nvr: "p-2.0-1.el9s" },
        testing: { nvr: "p-2.0-1.el9s" },
        release: { nvr: "p-1.0-1.el9s" },
      },
    },
  };
  const { rows } = computePromotion(matrix);
  assertEquals(rows[0].status, "promote-release");
  assertEquals(
    rows[0].nextAction,
    "cbs tag-build cloud9s-openstack-epoxy-release p-2.0-1.el9s",
  );
});

Deno.test("dist-git newer than candidate → unbuilt (build owed), build command emitted", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-nova": {
        candidate: { nvr: "openstack-nova-30.0.0-1.el9s" },
        testing: { nvr: "openstack-nova-30.0.0-1.el9s" },
        release: { nvr: "openstack-nova-30.0.0-1.el9s" },
      },
    },
  };
  const { rows } = computePromotion(matrix, [fact("openstack-nova", "30.0.1")]);
  assertEquals(rows[0].status, "unbuilt");
  assert(rows[0].buildOwed);
  assert(
    rows[0].nextAction?.startsWith(
      "cbs build cloud9s-openstack-epoxy-el9s git+",
    ),
  );
});

Deno.test("never-built package (no candidate) with a dist-git spec → unbuilt", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: { "openstack-new": {} },
  };
  const { rows } = computePromotion(matrix, [fact("openstack-new", "1.0.0")]);
  assertEquals(rows[0].status, "unbuilt");
});

Deno.test("no koji build in any tag → unknown", () => {
  const matrix: PromotionMatrix = { tags: TAGS, packages: { ghost: {} } };
  assertEquals(computePromotion(matrix).rows[0].status, "unknown");
});

Deno.test("rowFor: dist-git behind upstream (no CBS action) → behind-upstream", () => {
  const r = rowFor(
    "openstack-keystone",
    {
      candidate: { nvr: "openstack-keystone-27.0.2-1.el9s" },
      testing: { nvr: "openstack-keystone-27.0.2-1.el9s" },
      release: { nvr: "openstack-keystone-27.0.2-1.el9s" },
    },
    TAGS,
    fact("openstack-keystone", "27.0.2"),
    "27.1.0",
  );
  assertEquals(r.status, "behind-upstream");
  assert(r.behindUpstream);
  assertEquals(r.nextAction, null);
});

Deno.test("dist-tag noise: koji `1.el9s` vs spec `1` is not 'ahead' → current", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      p: {
        candidate: { nvr: "p-1.0-1.el9s" },
        testing: { nvr: "p-1.0-1.el9s" },
        release: { nvr: "p-1.0-1.el9s" },
      },
    },
  };
  // dist-git spec Release is bare `1` (%{?dist} unexpanded); must not read as
  // older than the koji `1.el9s` build.
  const { rows } = computePromotion(matrix, [fact("p", "1.0", "1")]);
  assertEquals(rows[0].status, "current");
});

Deno.test("epoch inversion: dist-git Epoch:1 must not mask being behind upstream (keystone)", () => {
  // The real keystone case: candidate holds a stale rc, testing==release at the
  // built GA, dist-git carries Epoch:1, upstream has moved to 27.0.2.
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-keystone": {
        candidate: { nvr: "openstack-keystone-27.0.0-0.1.0rc1.el9s", epoch: 1 },
        testing: { nvr: "openstack-keystone-27.0.0-1.el9s", epoch: 1 },
        release: { nvr: "openstack-keystone-27.0.0-1.el9s", epoch: 1 },
      },
    },
  };
  const dg: PackageFact = {
    ...fact("openstack-keystone", "27.0.0", "1"),
    epoch: "1",
  };
  const { rows } = computePromotion(matrix, [dg], [{
    deliverable: "keystone",
    latestVersion: "27.0.2",
    latestVersionSource: "vercmp-max",
    fileOrderVersion: "27.0.2",
    repos: ["openstack/keystone"],
    releaseCount: 1,
    series: "epoxy",
  }]);
  const k = rows[0];
  assertEquals(k.upstream, "27.0.2");
  assertEquals(k.behindUpstream, true);
  assertEquals(k.buildOwed, false); // 27.0.0 is already built in testing/release
  assertEquals(k.status, "behind-upstream");
});

Deno.test("sources flag: partial sources on an unbuilt package → flagged + build gated", () => {
  const dg: PackageFact = {
    ...fact("openstack-x", "2.0.0"),
    urlSources: ["x-2.0.0.tar.gz", "x-2.0.0.tar.gz.asc", "key.txt"],
    sourcesEntries: ["x-2.0.0.tar.gz"], // only the tarball staged (the keystone bug)
  };
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-x": {
        candidate: { nvr: "openstack-x-1.0.0-1.el9s" },
        testing: { nvr: "openstack-x-1.0.0-1.el9s" },
        release: { nvr: "openstack-x-1.0.0-1.el9s" },
      },
    },
  };
  const { rows, summary } = computePromotion(matrix, [dg]);
  assertEquals(rows[0].status, "unbuilt"); // dist-git 2.0.0 > built 1.0.0
  assertEquals(rows[0].sourcesStatus, "partial");
  assertEquals(summary.sourcesPartial, 1);
  assert(rows[0].nextAction?.includes("stage sources first"));
});

Deno.test("sources flag: stale sources (version mismatch) flagged; empty sources (RDO) not", () => {
  const stale: PackageFact = {
    ...fact("openstack-stale", "2.0.0"),
    urlSources: ["s-2.0.0.tar.gz"],
    sourcesEntries: ["s-1.0.0.tar.gz"], // old version still pinned
  };
  const rdo: PackageFact = {
    ...fact("openstack-rdo", "3.0.0"),
    urlSources: ["r-3.0.0.tar.gz"],
    sourcesEntries: [], // DLRN: no lookaside sources — informational, not a bug
  };
  const mk = (p: string) => ({
    candidate: { nvr: `${p}-9.9.9-1.el9s` },
    testing: { nvr: `${p}-9.9.9-1.el9s` },
    release: { nvr: `${p}-9.9.9-1.el9s` },
  });
  const { rows, summary } = computePromotion(
    {
      tags: TAGS,
      packages: {
        "openstack-stale": mk("openstack-stale"),
        "openstack-rdo": mk("openstack-rdo"),
      },
    },
    [stale, rdo],
  );
  const byName = Object.fromEntries(
    rows.map((r) => [r.package, r.sourcesStatus]),
  );
  assertEquals(byName["openstack-stale"], "stale");
  assertEquals(byName["openstack-rdo"], "none"); // NOT flagged as a bug
  assertEquals(summary.sourcesStale, 1);
  assertEquals(summary.sourcesPartial, 0);
});

Deno.test("sort surfaces actionable first; summary counts add up", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      zzz_current: {
        candidate: { nvr: "zzz_current-1-1.el9s" },
        testing: { nvr: "zzz_current-1-1.el9s" },
        release: { nvr: "zzz_current-1-1.el9s" },
      },
      aaa_promote: {
        candidate: { nvr: "aaa_promote-2-1.el9s" },
        testing: { nvr: "aaa_promote-1-1.el9s" },
        release: { nvr: "aaa_promote-1-1.el9s" },
      },
    },
  };
  const { rows, summary } = computePromotion(matrix);
  assertEquals(rows[0].package, "aaa_promote"); // actionable first despite name sort
  assertEquals(summary.total, 2);
  assertEquals(summary.promoteTesting, 1);
  assertEquals(summary.current, 1);
  assertEquals(
    summary.unbuilt + summary.promoteTesting + summary.promoteRelease +
      summary.behindUpstream + summary.ahead + summary.current +
      summary.unknown,
    summary.total,
  );
});

Deno.test("renderMarkdown + renderHtml produce content and escape safely", () => {
  const matrix: PromotionMatrix = {
    tags: TAGS,
    packages: {
      "openstack-keystone": {
        candidate: { nvr: "openstack-keystone-27.0.2-1.el9s" },
        testing: { nvr: "openstack-keystone-27.0.0-1.el9s" },
        release: { nvr: "openstack-keystone-27.0.0-1.el9s" },
      },
    },
  };
  const rep = computePromotion(matrix);
  const md = renderMarkdown(rep);
  assert(md.includes("## Action queue (1)"));
  assert(md.includes("openstack-keystone"));
  assert(md.includes("cbs tag-build cloud9s-openstack-epoxy-testing"));

  const html = renderHtml(rep);
  assert(html.startsWith("<!doctype html>"));
  assert(html.includes("prefers-color-scheme:dark"));
  assert(html.includes("data-theme=dark"));
  assert(html.includes("openstack-keystone"));
  assert(!html.includes("<script")); // no scripts — CSP-safe for Artifacts
});
