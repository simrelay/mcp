# Release architecture — two-repo setup

| Repo | Visibility | Role |
|---|---|---|
| `simrelay/mcp-server` | **private** | Source of truth. Builds test bundles on `main` pushes. On a `v*` tag, builds a **verification** prod bundle (internal artifact) and mirrors the tagged source to the public repo. Does **not** publish to npm. |
| `simrelay/mcp` | **public** | Receives the mirrored source. Independently builds the prod `.mcpb` from public source, attaches it to a public GitHub Release, **and publishes to npm with provenance via Trusted Publishing**. |

```
                ┌────────────────────────────────────┐
PRs ───►        │ simrelay/mcp-server  (private)     │
push main ──────│  build-test.yml  → test .mcpb art. │
push tag v* ───►│  release.yml                       │
                │    ├─ verification .mcpb (internal)│
                │    └─ mirror src + tag ────────┐   │
                └────────────────────────────────│───┘
                                                 ▼
                ┌─────────────────────────────────────┐
                │ simrelay/mcp  (public)              │
PRs ────►       │  ci.yml (validate only, no secrets) │
tag arrives ───►│  release.yml                        │
                │    ├─ prod .mcpb → public Release   │
                │    └─ npm publish (Trusted Pub.)    │
                └─────────────────────────────────────┘
```

## Why npm publish is in the public repo

We tried to publish from private first, but npm requires the source repo
behind a provenance attestation to be **public** — server-side enforced.
Publishing from private with provenance returns `E422 Unsupported GitHub
Actions source repository visibility: "private"`.

The original concern about a public repo's npm-publish surface being
attackable via PR is mitigated by three layered defenses:

1. **Trust binding is to `release.yml` only.** `ci.yml` (which runs on
   PRs) does not have the Trusted Publishing token.
2. **`release.yml` triggers on `v*` tag pushes** (and explicit
   `workflow_dispatch` by maintainers). No branch push, no PR can fire it.
3. **Branch protection on `main`** restricts who can push tags. Only org
   members can cut a release.

An attacker would need to get malicious code merged through PR review
**and** convince a maintainer to tag a release. That's normal
supply-chain threat-modelling — not a free win for the attacker.

## Secrets

### `simrelay/mcp-server` (private)

| Secret | Used by | What it is |
|---|---|---|
| `SIMRELAY_TEST_CLIENT_ID` | `build-test.yml` | OAuth client ID for test.simrelay.com |
| `SIMRELAY_PROD_CLIENT_ID` | `release.yml` | OAuth client ID for simrelay.com |
| `MIRROR_TOKEN` | `release.yml` mirror step | Fine-grained PAT, **Contents: Read & write** on `simrelay/mcp` only |

### `simrelay/mcp` (public)

| Secret | Used by | What it is |
|---|---|---|
| `SIMRELAY_PROD_CLIENT_ID` | `release.yml` | Same value as private's. Used to bake the OAuth client into the public prod build. |

No `NPM_TOKEN`. npm Trusted Publishing is configured to trust the **public** repo's release.yml — see the npm setup section below.

## Public repo workflow files

You set these up **once** on `simrelay/mcp`. The mirror step in private's `release.yml` explicitly skips `.github/workflows/` so it never overwrites these.

### `simrelay/mcp/.github/workflows/ci.yml`

Identical to private's `ci.yml` — copy it across. PR validation, no secrets, runs the test suite on a Node 20/22 × ubuntu/macos/windows matrix.

### `simrelay/mcp/.github/workflows/release.yml`

```yaml
# Public-repo release workflow.
#
# Triggered when the private simrelay/mcp-server repo mirrors a `v*` tag
# here. Rebuilds the prod .mcpb from public source, attaches it to a public
# GitHub Release, AND publishes the npm package via Trusted Publishing
# (which requires a public source repo per npm policy).
#
# Security:
#   * Trust binding is to THIS workflow file (release.yml) only — ci.yml on
#     PRs cannot mint the publish token.
#   * Triggers on `v*` tag pushes only. Fork PRs cannot touch this workflow.
#   * Tag pushes are gated by branch protection on `main` — only org members
#     can cut a release.
#   * Version validated against a strict regex before use.
#   * Secrets reach `run:` scripts only via `env:` (never direct ${{ }}).

name: Release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      version:
        description: "Manual rebuild: version (e.g. 2.0.0)"
        required: true

permissions:
  contents: write
  id-token: write   # required for npm Trusted Publishing OIDC

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          registry-url: "https://registry.npmjs.org"

      - run: npm ci

      - name: Upgrade npm for Trusted Publishing
        # Node 20/22 LTS ship with npm 10. Trusted Publishing GA needs npm
        # 11.5.1+. We upgrade *after* npm ci so the old lockfile installs
        # cleanly; the new npm is only used by `npm publish` below.
        run: npm install -g npm@latest

      - name: Determine and validate version
        id: ver
        env:
          MANUAL_VERSION: ${{ inputs.version }}
        run: |
          set -eu
          if [[ -n "${MANUAL_VERSION-}" ]]; then
            VERSION="${MANUAL_VERSION}"
          else
            VERSION="${GITHUB_REF_NAME#v}"
          fi
          if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)*$ ]]; then
            echo "Rejecting invalid version: ${VERSION}"
            exit 1
          fi
          if [[ "${VERSION}" == *-* ]]; then
            NPM_TAG="next"
            PRERELEASE="true"
          else
            NPM_TAG="latest"
            PRERELEASE="false"
          fi
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
          echo "npm_tag=${NPM_TAG}" >> "$GITHUB_OUTPUT"
          echo "prerelease=${PRERELEASE}" >> "$GITHUB_OUTPUT"

      - name: Verify package.json version matches tag
        env:
          EXPECTED_VERSION: ${{ steps.ver.outputs.version }}
        run: |
          set -eu
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [[ "${PKG_VERSION}" != "${EXPECTED_VERSION}" ]]; then
            echo "package.json version (${PKG_VERSION}) does not match tag (${EXPECTED_VERSION})."
            exit 1
          fi

      - name: Inject build config (prod)
        env:
          SIMRELAY_OAUTH_CLIENT_ID: ${{ secrets.SIMRELAY_PROD_CLIENT_ID }}
          BUILD_FLAVOR: prod
          BUILD_VERSION: ${{ steps.ver.outputs.version }}
        run: node scripts/inject-build-config.mjs

      - run: npm run build
      - run: npm test

      - name: Pack .mcpb
        env:
          BUNDLE_VERSION: ${{ steps.ver.outputs.version }}
        run: |
          set -eu
          npx -y @anthropic-ai/mcpb pack . "simrelay-mcp-${BUNDLE_VERSION}.mcpb"

      - name: Upload .mcpb artifact
        uses: actions/upload-artifact@v4
        with:
          name: simrelay-mcp-prod
          path: "*.mcpb"
          if-no-files-found: error

      - name: Publish to npm (Trusted Publishing via OIDC)
        if: startsWith(github.ref, 'refs/tags/v')
        env:
          NPM_DIST_TAG: ${{ steps.ver.outputs.npm_tag }}
        run: |
          set -eu
          npm publish --provenance --access public --tag "${NPM_DIST_TAG}"

      - name: Attach .mcpb to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: "*.mcpb"
          fail_on_unmatched_files: true
          generate_release_notes: true
          prerelease: ${{ steps.ver.outputs.prerelease == 'true' }}
```

Note: the mirror push from private resets `src/build-config.ts` to the committed null defaults before pushing — that's why the public can build its own prod bundle from the same source by injecting its own `SIMRELAY_PROD_CLIENT_ID` at build time.

## npm Trusted Publisher

Configure on the npm package — https://www.npmjs.com/package/simrelay-mcp-server/access → **Trusted Publishers** → **Add a publisher** → GitHub Actions:

- Organization: `simrelay`
- Repository: **`mcp`** *(the **public** mirror — npm requires public source for provenance)*
- Workflow filename: `release.yml`
- Environment: blank

That binding lets the public repo's `release.yml` mint a short-lived OIDC token that npm accepts as proof of identity — no `NPM_TOKEN` needed, and the publish carries a verifiable provenance attestation back to the public commit it was built from.

## OAuth client setup at SimRelay

Both clients (test + prod) must be **public PKCE clients** with `http://127.0.0.1:*/callback` in their allowed redirect URIs.

## End-to-end test (do this once)

1. **Create both repos** (one private, one public) — empty.
2. **In private**: `git remote add origin git@github.com:simrelay/mcp-server.git && git push -u origin main --follow-tags`.
3. **In public**: manually add `.github/workflows/ci.yml` (copy from private) and `.github/workflows/release.yml` (the inline YAML above). Push to public's main.
4. **Set secrets**:
   ```bash
   gh secret set SIMRELAY_TEST_CLIENT_ID --repo simrelay/mcp-server --body "<test client id>"
   gh secret set SIMRELAY_PROD_CLIENT_ID --repo simrelay/mcp-server --body "<prod client id>"
   gh secret set MIRROR_TOKEN          --repo simrelay/mcp-server --body "<fine-grained PAT>"
   gh secret set SIMRELAY_PROD_CLIENT_ID --repo simrelay/mcp        --body "<prod client id>"
   ```
5. **Bootstrap npm** (one time, manual): from a maintainer's machine, log in to npm and publish 2.0.x once with `--no-provenance` so the package exists on the registry. Then configure the Trusted Publisher (above) pointing at private.
6. **Cut a prerelease** from private to verify the whole pipeline:
   ```bash
   npm version 2.0.5-rc.0
   git push --follow-tags
   ```
   Expected:
   - Private's `release.yml` fires:
     - Test suite passes
     - Verification `.mcpb` attached to a **private** GitHub Release
     - Source mirrored to public + tag pushed
   - Public's `release.yml` fires from the tag arrival:
     - Test suite passes
     - **npm publishes** `simrelay-mcp-server@2.0.5-rc.0` under `next` dist-tag, with provenance pointing at the public commit
     - Public GitHub Release marked **prerelease** has `.mcpb` attached
7. **Cleanup**: `npm unpublish simrelay-mcp-server@2.0.5-rc.0` (within 72h), delete the tag from both repos, delete both Releases.

## Bringing community contributions back into private

PRs opened against the public `simrelay/mcp` repo can be cherry-picked by a maintainer into private's `main`. They land in public on the next release. Alternatively, disable PRs on public entirely and ask contributors to open issues.

## Why npm publish is in the public repo

We initially planned to publish from the private repo to minimize the
public-PR-attacks-workflow surface, but npm enforces a hard
server-side rule: **provenance attestations require the source
repository to be public**. Publishing from private with `--provenance`
fails with:

```
E422 Unsupported GitHub Actions source repository visibility: "private".
Only public source repositories are supported when publishing with provenance.
```

Dropping provenance to bypass this is a real security regression
(provenance is the strongest defense against compromised builds), so
we publish from public and lean on three layered defenses instead:

1. **Trust binding is to `release.yml` only** — `ci.yml` running on PRs
   cannot mint the publish token.
2. **`release.yml` triggers only on `v*` tag pushes** (or maintainer
   `workflow_dispatch`). No PR can fire it.
3. **Tag pushes require branch protection on `main`** — only org members
   can cut a release.

An attacker would have to get malicious code merged through PR review
AND convince a maintainer to tag a release — the standard
supply-chain threat model, not a free win.
