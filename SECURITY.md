# Security Policy

## Supported Version

Security fixes currently target the latest `0.3.x` source. Older local installations should be upgraded only after active Graph runners have stopped.

## Reporting A Vulnerability

Use the repository host's private security-advisory channel. Do not open a public issue for secret leakage, sandbox escape, path traversal, unsafe result application, authorization bypass, or remote-action execution.

Include the affected version, operating system, reproduction steps, expected boundary, observed behavior, and whether any external state changed. Remove credentials, tokens, personal data, and proprietary source from the report.

## Security Boundaries

Graph Engineering is not a security sandbox around an untrusted local adapter, agent CLI, or repository owner. It reduces risk through isolated workspaces, child-agent permissions, prohibited-action checks, exact owner gates, path and link validation, conflict-checked result application, secret redaction, and local evidence retention.

The configured agent CLIs and model endpoints remain trusted dependencies. Review their authentication, data-retention, and execution policies before using Graph on sensitive repositories.
