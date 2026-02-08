# From Deprecated npm Classic Tokens to OIDC Trusted Publishing: A CI/CD Troubleshooting Journey

> In January 2026, I encountered a series of cryptic authentication errors while publishing an npm package. This post documents the complete journey from problem discovery to final resolution—hopefully saving others from the same headaches.

## Background

I maintain an npm package called [amp-acp](https://www.npmjs.com/package/amp-acp), an adapter that bridges Amp Code to the Agent Client Protocol (ACP). The project uses GitHub Actions for automated releases: pushing a `v*` tag triggers automatic publishing to npm and creates a GitHub Release.

This workflow had been running smoothly—until late December 2025...

## The Problem

Starting with v0.3.1, every publish attempt failed. The GitHub Actions logs showed:

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
npm error need auth You need to authorize this machine using `npm adduser`
```

Even more confusing was this warning:

```
npm notice Security Notice: Classic tokens have been revoked. 
Granular tokens are now limited to 90 days and require 2FA by default. 
Update your CI/CD workflows to avoid disruption. 
Learn more https://gh.io/all-npm-classic-tokens-revoked
```

## Root Cause Analysis

### The End of npm Classic Tokens

After investigation, I discovered that **npm permanently deprecated all Classic Tokens on December 9, 2025**. According to the [GitHub official announcement](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/):

- All existing npm classic tokens have been permanently revoked
- Classic tokens can no longer be created or restored
- New Granular tokens have a maximum validity of 90 days and require 2FA by default

This means **the traditional approach of storing `NPM_TOKEN` in GitHub Secrets is no longer viable** (at least not as convenient as before).

### The New Authentication Method: OIDC Trusted Publishing

npm's recommended solution is **OIDC Trusted Publishing**. This OpenID Connect-based authentication mechanism offers several advantages:

1. **No token management** – No need to create, store, or rotate tokens
2. **Enhanced security** – Uses short-lived, cryptographically signed, workflow-specific credentials
3. **Automatic provenance** – Automatically generates provenance statements, providing build-origin transparency
4. **Industry standard** – Aligns with PyPI, RubyGems, crates.io, and other major package registries

## Troubleshooting Log

### Attempt 1: Upgrading npm Version

Initially, I assumed the issue was an outdated npm version, so I added this to the workflow:

```yaml
- name: Update npm to latest
  run: npm install -g npm@latest
```

**Result: Failed** ❌

### Attempt 2: Removing registry-url

Someone suggested removing the `registry-url` parameter from `actions/setup-node`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '22'
    # Removed registry-url
```

**Result: Failed** ❌

### Attempt 3: Setting NODE_AUTH_TOKEN to Empty String

Based on some outdated resources, I tried setting `NODE_AUTH_TOKEN` to an empty string:

```yaml
- name: Publish to npm
  run: npm publish --access public
  env:
    NODE_AUTH_TOKEN: ''
```

**Result: Failed** ❌

Here's the critical misconception: setting an empty `NODE_AUTH_TOKEN` actually **prevents** OIDC from working, because npm attempts to use the empty token instead of OIDC.

### Attempt 4: Completely Removing NODE_AUTH_TOKEN

I finally realized that for OIDC Trusted Publishing, **`NODE_AUTH_TOKEN` should not be set at all**:

```yaml
- name: Publish to npm
  run: npm publish --access public
  # Note: no env section
```

**Result: Partial success** ⚠️

This time OIDC authentication started working (logs showed `Signed provenance statement`), but a new error appeared:

```
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/amp-acp - 
Error verifying sigstore provenance bundle: Failed to validate repository information: 
package.json: "repository.url" is "", expected to match 
"https://github.com/tao12345666333/amp-acp" from provenance
```

### Attempt 5 (Final Success): Adding the repository Field

It turns out npm's Provenance validation requires `package.json` to include a `repository` field matching the GitHub repository:

```json
{
  "name": "amp-acp",
  "version": "0.3.7",
  "repository": {
    "type": "git",
    "url": "https://github.com/tao12345666333/amp-acp"
  }
}
```

**Result: Success!** ✅

## The Correct Configuration

### 1. Configure Trusted Publisher on npmjs.com

First, configure Trusted Publisher on the npm website:

1. Navigate to `https://www.npmjs.com/package/YOUR_PACKAGE/settings`
2. Find the "Trusted Publisher" section
3. Select "GitHub Actions"
4. Fill in the following:
   - **Organization/User**: Your GitHub username or organization name
   - **Repository**: Your repository name
   - **Workflow filename**: The workflow file name (e.g., `release.yml`)
   - **Environment**: (Optional) If using GitHub Environments

### 2. GitHub Actions Workflow Configuration

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  id-token: write   # Required for OIDC authentication
  contents: write   # Required for creating GitHub Release

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - name: Update npm to latest
        run: npm install -g npm@latest

      - name: Install dependencies
        run: npm ci

      - name: Publish to npm
        run: npm publish --access public
        # Note: Do NOT set NODE_AUTH_TOKEN!

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

### 3. Required package.json Fields

```json
{
  "name": "your-package-name",
  "version": "x.y.z",
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_USERNAME/YOUR_REPO"
  }
}
```

## Key Takeaways

1. **npm Classic Tokens are dead** – As of December 9, 2025, all classic tokens are permanently invalidated

2. **OIDC Trusted Publishing is the new standard** – No token management, enhanced security, built-in provenance

3. **Do not set NODE_AUTH_TOKEN** – For OIDC, this environment variable should not be set at all

4. **Configure Trusted Publisher on npmjs.com** – This step is often overlooked

5. **package.json must include the repository field** – Required for provenance validation

6. **Ensure id-token: write permission** – Otherwise, OIDC token generation will fail

7. **npm CLI version requirement** – Requires npm 11.5.1 or later

## FAQ

### Q: Can I use OIDC to publish the first version of a new package?

A: No. The first version must be published manually or using a traditional token. Trusted Publisher can only be configured afterward.

### Q: Can I use OIDC with self-hosted runners?

A: Currently, only GitHub/GitLab-hosted runners are supported. Self-hosted runners are not yet supported.

### Q: Why doesn't setting NODE_AUTH_TOKEN to an empty string work?

A: An empty string is still a value—npm will attempt to use it rather than falling back to OIDC. Only when this variable is completely unset will npm automatically use OIDC.

### Q: What should I do if provenance validation fails?

A: Verify that `repository.url` in `package.json` exactly matches the GitHub repository URL (including case sensitivity).

## References

- [npm Trusted Publishing Documentation](https://docs.npmjs.com/trusted-publishers)
- [GitHub Changelog: npm classic tokens revoked](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)
- [npm Provenance Introduction](https://docs.npmjs.com/generating-provenance-statements)

---

*Written on January 4, 2026, based on the publishing experience of amp-acp project from v0.3.1 to v0.3.7.*
