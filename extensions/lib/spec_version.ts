/**
 * Resolve `Version:` / `Release:` / `Epoch:` from an RPM spec, expanding the
 * common RDO pattern where the version comes from a top-of-file macro
 * (`%global upstream_version 27.0.2` … `Version: %{upstream_version}`).
 *
 * Deliberately shallow: it collects only *literal* `%global`/`%define`
 * definitions (values with no nested `%`) and substitutes them **one level**.
 * Anything still carrying a `%` after that pass — nested macros, conditionals,
 * parametric macros — is reported unresolved (`resolved: false`) with the raw
 * line preserved, so a human triages it instead of the pipeline silently
 * comparing garbage. A non-trivial unparsed fraction on real data is expected;
 * that is a signal to add a *targeted* pattern, not to grow a macro engine here.
 *
 * @module
 */

/** The outcome of parsing one spec's version tags. */
export interface SpecVersion {
  /** Resolved upstream version, or null when unresolved. */
  version: string | null;
  /** Resolved release (with `%{?dist}` and other unknowns stripped), or null. */
  release: string | null;
  /** Resolved epoch, or null when the spec has no `Epoch:` tag. */
  epoch: string | null;
  /** The raw `Version:` tag value, always preserved for human triage. */
  versionRaw: string | null;
  /** True only when `version` is fully-expanded, version-shaped, and non-empty. */
  resolved: boolean;
  /** Present when `resolved` is false — why the version couldn't be trusted. */
  unresolvedReason?: string;
}

/**
 * Substitute `%{name}`, `%{?name}`, and `%name` tokens from `macros`, one pass.
 * Unknown `%{?name}` expands to empty (RPM semantics); unknown `%{name}`/`%name`
 * is left intact so the caller can detect it. Returns whether a `%` survived.
 */
function substitute(
  value: string,
  macros: Map<string, string>,
): { out: string; unresolved: boolean } {
  let out = value.replace(
    /%\{(\??)(\w+)\}/g,
    (m, opt, name) => (macros.has(name) ? macros.get(name)! : (opt ? "" : m)),
  );
  out = out.replace(/%(\w+)/g, (m, name) => (macros.has(name) ? macros.get(name)! : m));
  return { out, unresolved: out.includes("%") };
}

/** Parse and resolve the version tags of a single spec file's text. */
export function resolveSpecVersion(specText: string): SpecVersion {
  const lines = specText.split(/\r?\n/);

  // Collect literal simple macros only (value must contain no nested macro).
  const macros = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^\s*%(?:global|define)\s+(\w+)\s+(.+?)\s*$/);
    if (m && !m[2].includes("%")) macros.set(m[1], m[2]);
  }

  // Last matching tag line wins (specs occasionally redefine).
  const tag = (name: string): string | null => {
    const re = new RegExp("^\\s*" + name + "\\s*:\\s*(.+?)\\s*$", "i");
    let val: string | null = null;
    for (const line of lines) {
      const m = line.match(re);
      if (m) val = m[1];
    }
    return val;
  };

  const versionRaw = tag("Version");
  const releaseRaw = tag("Release");
  const epochRaw = tag("Epoch");

  const release = releaseRaw != null ? substitute(releaseRaw, macros).out.trim() : null;
  const epoch = epochRaw != null ? substitute(epochRaw, macros).out.trim() : null;

  if (versionRaw == null) {
    return {
      version: null,
      release,
      epoch,
      versionRaw: null,
      resolved: false,
      unresolvedReason: "no Version tag",
    };
  }

  const v = substitute(versionRaw, macros);
  const version = v.out.trim();
  // The value must be macro-free AND actually version-shaped. A literal
  // placeholder like `Version: XXX` (real on this branch — aetos, neutron-fwaas,
  // cloudkitty-tests-tempest) expands cleanly yet is not a version; trusting it
  // puts a "bump from XXX" garbage row on the claimable list. RPM versions are
  // digit-led — require that, else route to the unparsed bucket for triage.
  // A `-` is deliberately excluded: in RPM a dash is the Version/Release
  // separator in the NVR triplet and is never legal inside Version itself —
  // accepting it let digit-led junk like `1-FIXME` slip past as "resolved".
  const versionShaped = /^[0-9][0-9A-Za-z.~^+_]*$/.test(version);
  if (v.unresolved || version === "" || !versionShaped) {
    const unresolvedReason = v.unresolved
      ? `unexpanded macro in Version: ${versionRaw}`
      : version === ""
      ? `empty Version after expansion: ${versionRaw}`
      : `implausible (non-version) Version: ${versionRaw}`;
    return { version: null, release, epoch, versionRaw, resolved: false, unresolvedReason };
  }

  return { version, release, epoch, versionRaw, resolved: true };
}
