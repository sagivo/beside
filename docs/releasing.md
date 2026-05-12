# Releasing Beside Desktop

Desktop releases are published from GitHub Actions when a version tag is pushed.
The workflow builds installers with `electron-builder`, uploads them to GitHub
Releases, and publishes the updater metadata consumed by the app at runtime.

## Release Flow

1. Update the app version in `package.json` and `packages/desktop/package.json`.
2. Merge the release commit to `main`.
3. Create and push a tag that matches the package version:

   ```sh
   git tag v0.2.1
   git push origin v0.2.1
   ```

4. The `desktop-release` workflow builds and publishes:
   - macOS: `.dmg`, `.zip`, and `latest-mac.yml`
   - Windows: NSIS installer and `latest.yml`
   - Linux: AppImage, deb package, and `latest-linux.yml`

Packaged apps check GitHub Releases on startup, then every six hours, and when
the user chooses **Check for Updates...** from the tray menu.

## Required Secrets

The workflow can build unsigned artifacts, but production releases should be
signed before users install them.

- `MACOS_CSC_LINK`: base64-encoded Developer ID Application certificate export.
- `MACOS_CSC_KEY_PASSWORD`: password for the macOS certificate export.
- `APPLE_ID`: Apple ID used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.
- `WINDOWS_CSC_LINK`: base64-encoded Windows code-signing certificate export.
- `WINDOWS_CSC_KEY_PASSWORD`: password for the Windows certificate export.

`GITHUB_TOKEN` is provided by GitHub Actions and is used by `electron-builder`
to create the release and upload update metadata.
