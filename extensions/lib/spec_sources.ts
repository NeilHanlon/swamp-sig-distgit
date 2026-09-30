/**
 * Parse the two halves of a dist-git package's source wiring:
 *  - the spec's URL-based `Source*` lines (the binary sources that must live in
 *    the lookaside, not git — tarball, `.asc`, gpg key, …), and
 *  - the `sources` metadata file that pins each to a lookaside blob.
 *
 * Used to detect the keystone failure mode: a version bump that updates the spec
 * but leaves the `sources` file stale/partial/empty, so a CBS `git+https` build
 * fails in `buildSRPMFromSCM` because it can't resolve a source from the
 * lookaside. Pure string parsing — no I/O, no macro engine (see the caveat on
 * {@link urlSourceBasenames}).
 *
 * @module
 */

/**
 * Basenames of the spec's URL-based `Source*` lines — the sources that go in
 * the lookaside. Local sources (a filename with no scheme, e.g. a committed
 * `foo.logrotate`) are excluded: they live in git and never need a `sources`
 * entry.
 *
 * Basenames are returned verbatim, so an unexpanded RPM macro survives (e.g.
 * `%{service}-%{upstream_version}.tar.gz`). Callers compare by count and by the
 * resolved version rather than by exact filename, so no macro engine is needed.
 *
 * @param specText The raw `<pkg>.spec`.
 */
export function urlSourceBasenames(specText: string): string[] {
  const out: string[] = [];
  for (const raw of specText.split(/\r?\n/)) {
    const m = raw.match(/^\s*Source\d*\s*:\s*(\S+)\s*$/i);
    if (!m) continue;
    const val = m[1];
    if (!/^https?:\/\//i.test(val)) continue; // URL sources only
    out.push(val.split("/").pop() ?? val);
  }
  return out;
}

/**
 * Filenames recorded in a `sources` metadata file. Handles both dialects:
 *  - Fedora/Stream: `SHA512 (name) = <hash>`
 *  - traditional:   `<hash>  SOURCES/name`  (or `<hash>  name`)
 *
 * Comment (`#`) and blank lines are ignored, so an RDO "not used for RDO Trunk
 * builds" comment-only file yields `[]` (correctly read as "no lookaside
 * sources"), not a bogus entry.
 *
 * @param text The raw `sources` file (empty string if absent).
 */
export function parseSourcesFile(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tagged = line.match(/^\w+\s*\(\s*([^)]+?)\s*\)\s*=/); // SHA512 (name) = ...
    if (tagged) {
      out.push(tagged[1]);
      continue;
    }
    const legacy = line.match(/^[0-9a-fA-F]{32,}\s+(?:SOURCES\/)?(\S+)\s*$/); // <hash> name
    if (legacy) out.push(legacy[1]);
  }
  return out;
}

/** A `sources`-vs-spec verdict for one package. */
export type SourcesStatus = "complete" | "partial" | "stale" | "none";

/**
 * Extract the version token from a source-tarball filename, or null. Assumes the
 * conventional `<name>-<version>.tar.<ext>` shape: the segment between the last
 * `-` and the archive extension.
 *
 * `keystone-27.0.2.tar.gz` → `27.0.2`; `foo.tar.gz` / non-archives → null.
 */
export function tarballVersion(filename: string): string | null {
  const m = filename.match(/-([^-]+)\.tar\.[a-z0-9.]+$/i);
  return m ? m[1] : null;
}

/**
 * Classify a package's source-staging state for the native `cbs build git+https`
 * path, from the spec's URL sources, the `sources` entries, and the spec version.
 *
 *  - **none**     — spec has URL sources but `sources` is empty. Normal for RDO
 *    Trunk packages (built via DLRN); informational, NOT a bug.
 *  - **stale**    — a tarball in `sources` names a different version than the
 *    spec. A bump that didn't re-stage sources — a real bug.
 *  - **partial**  — `sources` has fewer entries than the spec's URL sources.
 *    Some sources staged, others missing — a real bug (the keystone case).
 *  - **complete** — one `sources` entry per URL source, tarball version matches.
 *
 * A spec with zero URL sources is `complete` (nothing to stage).
 *
 * @param urlSources Basenames from {@link urlSourceBasenames}.
 * @param sourcesEntries Filenames from {@link parseSourcesFile}.
 * @param specVersion The resolved spec `Version:` (or null if unparsed).
 */
export function classifySources(
  urlSources: string[],
  sourcesEntries: string[],
  specVersion: string | null,
): SourcesStatus {
  if (urlSources.length === 0) return "complete";
  if (sourcesEntries.length === 0) return "none";
  if (specVersion) {
    for (const f of sourcesEntries) {
      const v = tarballVersion(f);
      if (v !== null && v !== specVersion) return "stale";
    }
  }
  if (sourcesEntries.length < urlSources.length) return "partial";
  return "complete";
}
