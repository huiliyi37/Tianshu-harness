# Public release catalog

`catalog.mjs` defines schema version 1 and source validation. The website keeps a byte-identical copy; desktop coordination remains private. Catalog revisions may change availability, but a version/platform/purpose must keep the same package bytes and updater signature. macOS installation DMGs and update archives are different artifacts.

From the product repository root, after building, signing and uploading the existing GitHub release:

```sh
node scripts/releases/generate-catalog.mjs
node scripts/releases/publish-atomgit.mjs                 # local validation and dry run
node scripts/releases/publish-atomgit.mjs --publish       # immutable upload + anonymous full readback
node scripts/releases/publish-atomgit.mjs --publish --acceptance release/atomgit-acceptance.json
node scripts/releases/publish-routing.mjs                # review metadata publication
node scripts/releases/publish-routing.mjs --publish --website ../tianshu-website
```

**Or run the whole close-out through the fail-closed wrapper** (pre-checks + post-verify with retry):

```sh
bash scripts/releases/publish-release-catalog.sh             # dry run (read-only pre-checks)
bash scripts/releases/publish-release-catalog.sh --publish   # publish
#   --with-atomgit              also run the AtomGit stage (requires the tag already mirrored)
#   --atomgit-acceptance FILE   real multi-network acceptance, to enable the source
```

If `github.com` is unreachable from your network, Node's built-in fetch times out even when `git`/`gh` still work through `git config http.proxy` — Node ignores env proxies unless told otherwise. Prefix with `HTTPS_PROXY=<proxy> NODE_USE_ENV_PROXY=1` in that case.

AtomGit requires the version tag to be mirrored beforehand. The publisher consumes `ATOMGIT_ACCESS_TOKEN` or the system Git credential helper without displaying either. It uses the official upload-address API and PUT headers, then checks the stable anonymous download entry, full SHA-256, size, HEAD and Range. No signed temporary URL is persisted. Missing credentials, login requirements, conflicting existing attachments or failed package checks stop publication. Provider quota and multi-network acceptance still need real measurements; this script does not certify unlimited bandwidth.

Anonymous byte verification alone leaves the source disabled. `--acceptance` must identify `schemaVersion: 1`, the exact `version`, `platform` and `sha256`, plus true `tauriRedirectVerified`, `stableEntryVerified`, `disconnectRetryVerified`, a nonempty `limitsObserved` record and at least two distinct `networks` observations (`name`, `checkedAt`, `passed: true`). Populate these only from actual tests. Without that record, the public package/signature/checksum may be uploaded, but updater metadata is deferred. After qualification, retrying preserves proof timestamps and revision instead of rewriting immutable metadata.

For several platforms, run `--platform <platform> --publish --assets-only --acceptance <platform-evidence>` for each intended update platform. Complete the catalog's AtomGit qualification for every update platform before publishing either immutable metadata file. An incomplete platform set fails before any metadata upload; it cannot lock in a Windows-only manifest while macOS assets are still pending. HEAD is informational and may fail; Range acceptance must match the requested interval, total package size and bytes, not merely return HTTP 206.

After asset qualification, finalize or resume metadata publication without reuploading/revalidating the large package:

```sh
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release
# Review the complete platform list, then explicitly publish:
node scripts/releases/publish-atomgit.mjs --metadata-only --catalog release-catalog.json --assets release --publish
```

This uploads and anonymously reads back both `latest.json` and `release-catalog.json`, preserving the exact catalog bytes published to GitHub/OSS and pinned by update control. Identical existing metadata is verified and reused; different immutable files are rejected. Adding platforms after immutable metadata has already been uploaded requires a new release or a separately reviewed metadata revision. Repeating a partially completed publication preserves verified proof timestamps and the revision. Unqualified assets may be uploaded with `--assets-only`, but cannot publish enabled metadata.

Controlled clients prefer the pinned AtomGit catalog, then the pinned OSS **metadata**, then GitHub in automatic/AtomGit mode; explicit GitHub mode prioritizes GitHub metadata. This does not enable automatic OSS package downloads. Each metadata route retries direct after an application-proxy network failure, including fresh version manifests as well as restored manifests. Catalog digest/format/size failures stop the operation instead of falling through to another mirror. Both control sources are still checked for pause, revocation and the highest revision; a fast package mirror does not bypass policy. Existing releases without an AtomGit catalog continue through the fallback metadata routes.

Only the catalog is published to GitHub/OSS by `publish-routing.mjs`; the existing package upload workflow remains responsible for OSS backup files. It checks an existing GitHub catalog for immutable artifact identity and monotonic revisions, then uploads the small catalog and requests the website's existing `tianshu-release` dispatch. GitHub and OSS permissions plus website dispatch access must be configured on the publishing host. The site's daily deployment remains a compensating run. Files uploaded before a later failure stay in place for idempotent retry.

Old OSS `latest.json` is unchanged unless the operator supplies `--enable-legacy-atomgit`. That option refuses to redirect Windows unless the catalog contains verified anonymous AtomGit evidence and the original signature matches. New clients never select an OSS package automatically; a manual OSS attempt still verifies the original updater signature and catalog SHA-256 before installing. CLI/npm updates are unchanged.

Desktop source and terminal download events are stored in the application's data directory as `update-downloads.jsonl`. `report-routing.mjs <ledger>` reports source choice, fallbacks, success/failure and received bytes. These are client observations, **not** OSS billed egress or website click counts. Retrieve those separately from provider billing/access logs and website analytics.

Checks:

```sh
node --test scripts/releases/catalog.test.mjs
node scripts/releases/verify-restored-defects.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml update_routing --lib
python3 desktop/scripts/verify-update-rust-defects.py
cd desktop
node --import tsx scripts/verify-update-routing.mjs
```

Human-facing release summaries live in `docs/releases/summaries/<version>.json`. Supply both languages and no more than three reviewed highlights. `generate-catalog.mjs` adds the optional `releaseNotesUrl` only when a matching validated summary exists. `publish-routing.mjs` publishes `release-notes.json` before the catalog and refuses to replace different bytes for the same version. The desktop bundles these same files for offline display. Existing catalogs and notes-free releases remain supported.

Before publishing a catalog with `releaseNotesUrl`, a release owner must review both localized summaries and supply `--release-notes-reviewed`. The checked-in 3.28.0 summary is a reviewable initial draft, not evidence of that human approval. No notes or routing data are uploaded by the desktop build.


## Controlled desktop rollout

The independent control protocol uses `update-control.json` at the OSS fixed path and at GitHub's fixed `update-control` prerelease attachment. It does not resolve through `releases/latest`. This is release metadata only; desktop implementation stays private.

First release a fully tested desktop version containing the control client. Before users install it, initialize revision 1 from the current stable catalog. Initialization must be deployed before the control client needs to update: missing or invalid control blocks new downloads and installs. Old clients continue using the existing stable endpoints.

```sh
node scripts/releases/publish-update-control.mjs init --catalog release-catalog.json
# Add --publish only after reviewing the dry run.
```

Upload the next signed numeric-version release as **prerelease**, along with its complete, source-qualified `latest.json`, `release-catalog.json` and release notes. Finish source qualification before staging: referenced catalog bytes become immutable. Keep the previous stable catalog and legacy manifests unchanged. OSS package uploads must use `bash scripts/upload-update-to-oss.sh --assets-only`; AtomGit's existing immutable package publisher can also be used with `--assets-only`; do not run the stable close-out wrapper for a candidate.

Copy `rollout-acceptance.example.json` into your release working directory and fill it from actual tests. `passed`, `sha256`, timestamp and a maintainer conclusion are required per platform. The supplied template deliberately cannot pass validation. Do not substitute an automated browser fixture for a real signed upgrade.

```sh
node scripts/releases/publish-update-control.mjs stage --catalog release/candidate-catalog.json --platforms windows-x86_64,darwin-aarch64,darwin-x86_64 --acceptance release/rollout-acceptance.json
node scripts/releases/publish-update-control.mjs set-percentage --catalog release/candidate-catalog.json --percentage 1 --acceptance release/rollout-acceptance.json
node scripts/releases/publish-update-control.mjs pause --catalog release/candidate-catalog.json --platforms windows-x86_64
node scripts/releases/publish-update-control.mjs resume --catalog release/candidate-catalog.json --platforms windows-x86_64
node scripts/releases/publish-update-control.mjs revoke --catalog release/candidate-catalog.json
```

Each command defaults to a read-only dry run. `--publish` explicitly writes remote metadata. `--control FILE` selects the local confirmed control snapshot; `--transaction FILE` selects the local retry receipt (default `release/update-control-transaction.json`). Preserve this receipt after partial failure and retry the exact command and evidence. It preserves the revision, verifies already-written bytes and completes remaining sources. Another publisher's newer revision or conflicting content stops the retry. Both sources are read back before reporting success. Candidate operations never refresh the website or replace legacy stable manifests.

Suggested manual steps are preview → 1 → 5 → 20 → 50 → 100 percent. Configure all intended platforms at staging. Each increase requires platform evidence; percentages cannot decrease. Pause freezes new download and installation attempts; an existing transfer may finish but still cannot install. Revocation applies to the whole candidate version and cannot be undone. Publish a higher version to repair an already-installed faulty release; there is no automatic downgrade. Revocation history must remain in future revisions. Control and catalog responses are capped at 256 KiB.

The install cohort is random and stored locally, stable across upgrades, independent per version/platform, and never transmitted. Ordinary manual checks obey the same cohort rules. Explicit update preview bypasses percentages only for active candidates, downloads manually, and cannot bypass pause, revocation or verification. Turning preview off does not downgrade an installed version and blocks an unpromoted cached preview package. Preview is public access, not an authorization mechanism.

New clients fetch both control sources on checks and revalidate over the network before download, cache restoration and stopping tasks for installation. No legacy latest fallback exists. Checks currently use fresh metadata instead of caching it. During a transfer, revocation is observed by a 60-second policy poll and a completion check; this is not remote push. Policy/network failures preserve verified cached packages. Revoked packages are discarded when revocation is observed. Old-format stable receipts remain readable and can install eligible, non-revoked versions up to the current stable release. A shutdown-save override never overrides update policy.

Promote only after every published update platform reaches 100% and acceptance records include actual signed Windows and macOS upgrades (`realSignedUpgrade: true`). The root catalog and root `latest.json` must match the candidate, and bilingual release notes require publisher review. This is the only controlled operation that changes the old stable endpoints and dispatches a website refresh:

```sh
node scripts/releases/publish-update-control.mjs promote --catalog release-catalog.json --acceptance release/rollout-acceptance.json --release-notes-reviewed --website ../tianshu-website
```

Run the command as a dry run first; add `--publish` after review. Promotion is multi-step rather than globally atomic: the saved receipt identifies partial completion, and retries converge control, GitHub release status and stable manifests. Website dispatch confirms a refresh request, not a completed website deployment. Verify the deployed download page separately.

Local `update-downloads.jsonl` now includes policy selection, channel, policy revision, platform and upgrade attempts. An installer returning success means `installer_returned`; only the target version plus a ready sidecar means `confirmed`. Reopening the old version records `not_completed`; a target boot without readiness after 60 seconds records `pending` and can later become confirmed. `report-routing.mjs` retains the latest result per attempt and summarizes failure stages. Attempt identifiers are random per attempt and are unrelated to the installation cohort identifier. No feedback is uploaded.

```sh
node --test scripts/releases/update-control.test.mjs
node scripts/releases/verify-update-control-defects.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml update_routing --lib
python3 desktop/scripts/verify-update-rust-defects.py 'install policy bypass'
node scripts/releases/report-routing.mjs /path/to/update-downloads.jsonl
```

These tests cover mocked/native boundaries and local HTTP services. They do not certify a real Windows/macOS package upgrade or public mirror deployment.
