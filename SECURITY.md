# Security Policy

## Supported versions

NeoProtocol is pre-v1. Only the `master` branch receives security
fixes. There are no released versions yet — once v1 ships, this
table will list supported version ranges.

## Reporting a vulnerability

If you find a security issue (in the spec, the reference Originator,
the reference Executors, or the conformance suite), please **do not**
open a public GitHub issue.

Instead, contact the maintainer privately:
- Open a GitHub Security Advisory via the **Security** tab of the
  repository (preferred — it gives us a private channel that can
  later be published)
- Or email the address listed on the maintainer's GitHub profile

Please include:
- A description of the issue and what part it affects (spec /
  Originator / Executor / suite)
- Steps to reproduce
- Impact: data leak, code execution, denial of service, etc.
- Any suggested fix or mitigation

## Response timeline (best effort, pre-v1)

- Acknowledgement: within 7 days
- Initial assessment: within 14 days
- Fix or mitigation plan: within 30 days for high-severity issues

This timeline tightens after v1.

## Scope

In scope:
- Spec ambiguities that allow data leakage between Originator and
  Executor (e.g., a way to bypass `data_locality.returns_to_originator`)
- Reference Originator vulnerabilities (`server/`)
- Reference Executor vulnerabilities (`examples/sentiment-poc/`,
  `examples/python-executor/`)
- Conformance suite vulnerabilities

Out of scope (still appreciated as bug reports, but not security):
- Third-party dependency CVEs (we update them as they're disclosed)
- Issues only reproducible with non-conformant implementations
- DoS via genuine resource limits (large model downloads, etc.)
