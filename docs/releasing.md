# Releasing Beside Desktop

Desktop releases are currently built, signed, notarized, and published from a
local macOS machine with `electron-builder`. GitHub Actions release jobs are
disabled for now. Published artifacts are uploaded to GitHub Releases, which
also provides the updater metadata consumed by the app at runtime.

## Release Flow

1. Update the app version in `package.json` and `packages/desktop/package.json`.
2. Commit the release change to `main`.
3. Configure the local signing/notarization environment:

   ```sh
   export CSC_LINK=/path/to/developer-id-application.p12
   export CSC_KEY_PASSWORD='...'
   export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
   export APPLE_API_KEY_ID=XXXXXXXXXX
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   export GH_TOKEN=ghp_...
   ```

4. Create and push a tag that matches the package version:

   ```sh
   git tag v0.2.1
   git push origin main --tags
   ```

5. Build and publish the macOS Apple Silicon release:

   ```sh
   pnpm --filter @beside/desktop run dist -- --mac --arm64 --publish always
   ```

   This produces and publishes the `.dmg`, `.zip`, and `latest-mac.yml`.

Packaged apps check GitHub Releases on startup, then every six hours, and when
the user chooses **Check for Updates...** from the tray menu.

## Required Local Credentials

Production releases must be signed and notarized before users install them.

- `CSC_LINK`: path or base64 value for a Developer ID Application certificate export.
- `CSC_KEY_PASSWORD`: password for the macOS certificate export.
- `APPLE_API_KEY`: path to the App Store Connect API key file.
- `APPLE_API_KEY_ID`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer UUID.
- `GH_TOKEN`: GitHub token used by `electron-builder` to create or update the release.

To test packaging without publishing:

```sh
pnpm --filter @beside/desktop run dist -- --mac --arm64 --publish never
```
