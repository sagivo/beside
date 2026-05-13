# Security Policy

Beside captures and indexes local desktop activity, so privacy and local data
handling are part of the security boundary.

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities or privacy-sensitive data
exposure. Email security reports to hello@beside.ai with:

- A description of the issue and impact.
- Steps to reproduce or a proof of concept.
- Affected platform and version, if known.
- Whether any user data, credentials, local files, or captured content may be
  exposed.

We will acknowledge reports as quickly as possible and coordinate disclosure
once a fix is available.

## Sensitive Data Guidelines

Do not commit:

- `.env` files, API keys, signing certificates, or tokens.
- Local capture data, screenshots, OCR dumps, transcripts, SQLite databases, or
  exported indexes.
- Build outputs, release artifacts, or generated plugin `dist/` folders.

If sensitive data was committed to git history, remove it from history before
publishing or distributing the repository.
