# Releasing Beside Desktop

Desktop releases are currently built, signed, notarized, verified, and
published from a local macOS machine. GitHub Actions release jobs are disabled
for now. Published artifacts are uploaded to GitHub Releases, which also
provides the updater metadata consumed by the app at runtime.

## Release Flow

1. Update the app version in `package.json` and `packages/desktop/package.json`.
2. Commit the release change to `main`.
3. Configure the local signing/notarization environment. The release script can
   use either a `notarytool` keychain profile or raw Apple credentials:

   ```sh
   export APPLE_KEYCHAIN_PROFILE=beside

   # Or, instead of a keychain profile:
   export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
   export APPLE_API_KEY_ID=XXXXXXXXXX
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

   `gh` must also be authenticated for `sagivo/beside`:

   ```sh
   gh auth status
   ```

4. Build, verify, tag, and publish the macOS Apple Silicon release:

   ```sh
   pnpm release:desktop
   ```

   This produces and publishes the `.dmg`, `.zip`, blockmaps, and
   `latest-mac.yml`.

   To replace an existing release tag, such as rebuilding `v0.0.1`, use:

   ```sh
   pnpm release:desktop -- --force-tag
   ```

   To build and verify locally without touching GitHub:

   ```sh
   pnpm release:desktop -- --no-upload
   ```

The script verifies the packaged app, validates stapled notarization tickets,
runs the packaged plugin smoke test, checks Gatekeeper acceptance, mounts the
DMG to confirm it contains `Beside.app`, and verifies GitHub asset digests
after upload. If `electron-builder` produces a DMG without the app payload, the
script rebuilds the DMG from the verified app bundle, then signs, notarizes,
staples, and regenerates update metadata before uploading.

Packaged apps check GitHub Releases on startup, then every six hours, and when
the user chooses **Check for Updates...** from the tray menu.

## Required Local Credentials

Production releases must be signed and notarized before users install them.

- Developer ID Application signing identity in Keychain.
- `APPLE_KEYCHAIN_PROFILE`: `notarytool` keychain profile used for notarization.
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: App Store Connect API credentials, if not using a keychain profile.
- Authenticated `gh` CLI session with permission to push tags and upload release assets.

To test packaging without publishing:

```sh
pnpm release:desktop -- --no-upload
```
