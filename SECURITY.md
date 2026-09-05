# Security Policy

## Supported versions

This project is small and actively maintained on `main`. Please report issues against the latest commit on `main`.

## Reporting a vulnerability

If you find a security issue (for example, session handling, credential leakage, or unsafe defaults):

1. **Do not** open a public GitHub issue with exploit details.
2. Email the maintainer via the address on their [GitHub profile](https://github.com/Thespaceblade), or open a private security advisory on the repo if available.
3. Include steps to reproduce and impact. Do not include live Onyen credentials or `storage-state.json` contents.

## Session data

Login cookies are stored under `~/.unc-libcal/storage-state.json`. Treat that file like a password. Never commit it or paste it into issues/PRs.
