# Historical Changesets directory

This repository previously used Changesets to version and publish both
workspace packages. That automation is retired because the public npm
distribution is ONLY zenith-mcp, with zenith-toon bundled into it.

Both workspace packages remain separate for development and testing, but
zenith-toon must NOT be published independently.

To prepare a release, increase the version in both root package.json and
packages/zenith-mcp/package.json, then run:

    pnpm release:publish

This tests both packages, builds them, assembles one npm archive, verifies
a clean npm installation, and publishes the verified archive under latest.
An interactive npm 2FA authentication challenge may be required.

For CI publishing, run the Publish Zenith-MCP GitHub Actions workflow.
The release.yml workflow now performs verification only.
See docs/PUBLISHING.md for detailed instructions.
