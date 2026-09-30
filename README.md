# @kneel/sig-distgit

A [swamp](https://github.com/swamp-club/swamp) model that scans a **CentOS SIG
dist-git group** on gitlab.com and resolves each package's spec version.

The SIG keeps one project per package under a group (default
`CentOS/cloud/rpms`), each carrying a `<name>.spec` on a per-stream branch
(default `c9s-sig-cloud-epoxy`). A single `scan()` method fans out over the whole
group in one execution: it paginates projects, fetches every spec at the branch
(bounded concurrency, optional PAT), resolves `Version:` / `Release:` / `Epoch:`
— expanding the common RDO `%global upstream_version …` indirection — reads the
lookaside `sources` file state, and persists:

- `packages` — per-package resolved spec facts (version, release, epoch, sources state)
- `scan-summary` — headline counts + triage lists (scanned / missing-branch / unparsed)

It's read-only: nothing is written to gitlab.

## Usage

```bash
swamp extension pull @kneel/sig-distgit
swamp model create @kneel/sig-distgit cloud-sig-epoxy
swamp model method run cloud-sig-epoxy scan
swamp data get cloud-sig-epoxy scan-summary --json
```

Global arguments (all optional; defaults target CentOS Cloud SIG / Epoxy):
`gitlabUrl` (default `https://gitlab.com`), `group` (default `CentOS/cloud/rpms`),
`branch` (default `c9s-sig-cloud-epoxy`), `concurrency` (default 5), `maxProjects`
(0 = no cap), and an optional `token` (vault it) for authenticated reads.

## Where it's used

Part of the CentOS Cloud SIG packaging pipeline — see
[cloud-sig-swamp](https://github.com/NeilHanlon/cloud-sig-swamp), where its scan
feeds the `sig-promote` report (in `@kneel/koji`) alongside CBS build tags and
upstream OpenStack releases.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
