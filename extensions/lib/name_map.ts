/**
 * Map a Cloud SIG distgit package name to its upstream OpenStack deliverable.
 *
 * This is the highest-risk component of the Epoxy inventory: a wrong mapping
 * silently marks a `behind` package as `unmatched` and it drops off the
 * volunteer list. So it is a **checked-in, ordered, tested** ruleset with a
 * manual override table on top — every decision records which rule fired
 * (`via`) for audit, and anything that matches nothing lands in `unmatched`
 * with a reason (never dropped). A large `unmatched` count is a mapping bug to
 * fix in {@link MANUAL_MAP}, not a data reality.
 *
 * The known OpenStack-isms, each covered by a rule and a fixture:
 *  - `openstack-<x>`               → deliverable `<x>`
 *  - `python-oslo-<x>`             → deliverable `oslo.<x>` (dot↔dash — classic miss)
 *  - `python-<x>-tests-tempest`    → deliverable `<x>-tempest-plugin`
 *  - `python-<x>client`            → deliverable `python-<x>client` (don't strip)
 *  - other `python-<x>`            → deliverable `<x>` / repo `openstack/python-<x>`
 *  - `puppet-*`, standalone tools, independent-release libs, retired → `unmatched`
 *
 * @module
 */

/** The deliverable universe to match against, built from a snapshot. */
export interface DeliverableIndex {
  /** Every deliverable name in the series (e.g. `keystone`, `oslo.config`). */
  names: Set<string>;
  /** `openstack/<repo>` → owning deliverable name, for repo-based matches. */
  repos: Map<string, string>;
}

/** A successful match (with the rule that produced it) or an explicit miss. */
export type MapResult =
  | { deliverable: string; via: string }
  | { unmatched: true; reason: string };

/**
 * Explicit overrides for names the heuristics get wrong. Grows as review finds
 * misses. Keys are distgit names, values are deliverable names. Seeded from the
 * first live Epoxy scan for names no general rule can safely reach:
 *  - `python-keystoneauth1` → `keystoneauth` (the distgit keeps the legacy `1`).
 *  - `python-django-horizon` → `horizon` (distgit prefixes the Django package).
 */
export const MANUAL_MAP: Record<string, string> = {
  "python-keystoneauth1": "keystoneauth",
  "python-django-horizon": "horizon",
};

/** Build a {@link DeliverableIndex} from a snapshot's deliverable entries. */
export function buildIndex(
  deliverables: Array<{ deliverable: string; repos: string[] }>,
): DeliverableIndex {
  const names = new Set<string>();
  const repos = new Map<string, string>();
  for (const d of deliverables) {
    names.add(d.deliverable);
    for (const r of d.repos) repos.set(r, d.deliverable);
  }
  return { names, repos };
}

/**
 * The `<x>-tempest-plugin` deliverable a distgit `python-<x>-tests-tempest`
 * ships, or null. Shared by {@link mapName} (rule 4b) and the report's
 * `suggestDeliverable` so the SIG's `-tests-`→`-tempest-plugin` rename is
 * expressed once, not duplicated across the two consumers.
 */
export function tempestPluginDeliverable(distgit: string): string | null {
  const m = distgit.match(/^python-(.+)-tests-tempest$/);
  return m ? `${m[1]}-tempest-plugin` : null;
}

/** Map one distgit package name to its deliverable, or report it unmatched. */
export function mapName(distgit: string, idx: DeliverableIndex): MapResult {
  const has = (n: string) => idx.names.has(n);
  const repo = (r: string) => idx.repos.get(r);

  // 1. Manual override wins; a target that isn't a real deliverable surfaces
  //    as a typo rather than being trusted blindly.
  if (Object.prototype.hasOwnProperty.call(MANUAL_MAP, distgit)) {
    const t = MANUAL_MAP[distgit];
    return has(t)
      ? { deliverable: t, via: "manual" }
      : { unmatched: true, reason: `manual map -> unknown deliverable '${t}'` };
  }

  // 2. The distgit name is itself a deliverable (covers e.g. python-<x>client).
  if (has(distgit)) return { deliverable: distgit, via: "exact" };

  // 3. Strip the openstack- prefix.
  if (distgit.startsWith("openstack-")) {
    const t = distgit.slice("openstack-".length);
    if (has(t)) return { deliverable: t, via: "strip-openstack" };
  }

  // 4. oslo libraries: python-oslo-<x> / python-oslo.<x> → oslo.<x> (dot↔dash).
  const om = distgit.match(/^python-oslo[.-](.+)$/);
  if (om) {
    const rest = om[1];
    for (const cand of ["oslo." + rest.replace(/-/g, "."), "oslo." + rest]) {
      if (has(cand)) return { deliverable: cand, via: "oslo-dot" };
    }
  }

  // 4b. Tempest plugins: distgit python-<x>-tests-tempest ships the upstream
  //     <x>-tempest-plugin deliverable (the SIG renames it on the -tests- axis).
  const tpn = tempestPluginDeliverable(distgit);
  if (tpn && has(tpn)) return { deliverable: tpn, via: "tempest-plugin" };

  // 5. Clients: keep the python- prefix.
  const cm = distgit.match(/^python-.+client$/);
  if (cm) {
    if (has(distgit)) return { deliverable: distgit, via: "client" };
    const d = repo("openstack/" + distgit);
    if (d) return { deliverable: d, via: "client-repo" };
  }

  // 6. General python-<x>.
  const pm = distgit.match(/^python-(.+)$/);
  if (pm) {
    const x = pm[1];
    if (has(x)) return { deliverable: x, via: "python-strip" };
    for (const r of ["openstack/python-" + x, "openstack/" + x]) {
      const d = repo(r);
      if (d) return { deliverable: d, via: "python-repo" };
    }
  }

  // 7. Repo match on the bare / prefix-stripped name.
  for (const cand of [distgit, distgit.replace(/^openstack-/, "")]) {
    const d = repo("openstack/" + cand);
    if (d) return { deliverable: d, via: "repo" };
  }

  return { unmatched: true, reason: `no rule matched '${distgit}'` };
}
