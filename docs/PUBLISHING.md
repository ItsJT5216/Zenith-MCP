# Publishing Zenith-MCP: one npm package

The public npm distribution is **zenith-mcp only**. The source repository has
two development workspaces, zenith-mcp and zenith-toon. TOON is compiled and
bundled into the main archive. Never publish zenith-toon independently.

## Release from a local terminal

Use Node 26.3.0+ (major 26) and the pnpm version in the root packageManager
field. Ensure your intended source changes are committed. Bump the version in
BOTH the root package.json and packages/zenith-mcp/package.json to an as-yet
unpublished version.

In the repository root, run:

    pnpm install --frozen-lockfile
    pnpm release:publish

The publish script runs both workspaces' tests, builds both workspaces, copies
TOON into the staged dist/toon directory, rewrites the staged compiler import,
packs a **single** npm archive, tests a fresh npm installation, then publishes
the exact verified tarball with the latest dist-tag.

To inspect before publishing:

    pnpm release:pack
    pnpm release:verify
    node scripts/publish-npm-package.mjs --tag latest --dry-run

The temporary package and SHA-256/SRI manifest are under .release/ (gitignored).
Nothing in the workspace source or compiled workspace output is rewritten.

## npm account authorization

The npm account must own zenith-mcp or have publish rights. The npm CLI may
require interactive two-factor authentication even when npm whoami succeeds.
If publication returns EOTP, complete the browser prompt from the terminal
and retry the command. Do not disable 2FA.

For GitHub Actions publishing, configure a trusted publisher for the existing
zenith-mcp package in npmjs.com > Package > Settings > Trusted publishing:

- Provider: GitHub Actions
- Organization/user: ItsJT5216
- Repository: Zenith-MCP
- Workflow filename: publish.yml
- Allowed action: npm publish; enable npm dist-tag too if using staging

The publish workflow has id-token: write for trusted OIDC publishing.
Alternatively, a correctly scoped publish-capable npm token satisfying
npm's 2FA policy can be configured as the Actions repository secret NPM_TOKEN.

## GitHub release workflow

The Publish Zenith-MCP workflow offers manual runs:

- Stage publishes to the next tag.
- Production publishes to the latest tag.
- Dry run defaults to true, so an unintentional click does not publish.

Publishing a GitHub Release also initiates a production publish. Its tag must
equal the package version, with an optional v prefix.

If a version already exists on npm, the publisher compares the registry
integrity with the staged archive. Only an exact match can be retagged.
This lets you stage under next and later promote the same immutable version
to latest without publishing it twice.

The separate Release Readiness workflow runs build, tests and a clean-install
archive verification after pushes to main, without any publishing credentials.

## Verify the public package

    npm view zenith-mcp version dist-tags --json
    npm view zenith-mcp@latest dependencies --json
    npx --yes zenith-mcp@latest /path/to/project

The dependencies must not contain zenith-toon. The last command starts the
Zenith MCP stdio server, which normally stays running until disconnected.

## Failure and rollback

npm never permits overwriting an already-published package/version pair. For
new code, increment the version and publish again. If staging was already
published under next, production mode can safely move latest to that version
after checking that the package archive is byte-for-byte identical.
If a published release has a serious bug, publish a corrected version and
move latest to it; do not silently replace the old version's contents.
