# Contributing

Thanks for your interest in Beside. This project is a local-first desktop app
and plugin runtime, so changes should preserve the default privacy posture:
captured data stays on the user's machine unless they explicitly configure an
external service.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

For desktop development:

```bash
pnpm dev
```

Before opening a pull request, run the relevant checks for the area you changed.
For broad changes, run the full command set above.

## Pull Requests

- Keep changes focused and explain the user-visible behavior change.
- Do not commit local capture data, OCR dumps, SQLite databases, secrets, or
  generated `dist/` and release artifacts.
- Add or update tests for behavior that is shared, user-facing, or easy to
  regress.
- Call out privacy, storage, or network behavior changes explicitly in the PR.

## Security and Privacy

If you find a vulnerability or a privacy-sensitive issue, please follow
`SECURITY.md` instead of opening a public issue.
