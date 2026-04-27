# Contributing to NeoProtocol

Thanks for your interest. NeoProtocol is pre-v1, so the spec and the
reference implementations are both moving targets — but contributions
are welcome at every level (typo fixes through new conformance levels).

## What kinds of contributions help most right now

**High-impact**
- Independent implementations in other stacks (Rust, Go, Java, Swift)
  exercising the same `graph.json` against the reference Originator
- Bug reports against the conformance suite (especially edge cases
  the suite misses)
- Spec ambiguities — places where two implementers could reasonably
  disagree on what's correct
- Adapter implementations (LangGraph, CrewAI, AutoGen, Burr, ...)

**Medium-impact**
- Additional conformance test cases (especially for Levels 1+)
- Reducer types we haven't considered
- Real-world workload demos (Email triage, RAG, PII redaction, etc.)
- Documentation improvements

**Always welcome**
- Typo / clarification PRs
- Translations of SPEC.md / README.md

## Development workflow

```bash
# 1. fork + clone
git clone https://github.com/<you>/NeoProtocol.git
cd NeoProtocol

# 2. branch
git checkout -b your-feature

# 3. make changes, run the relevant tests
cd server && npm install && npm run smoke      # server-side
cd ../conformance && python -m originator.level0 --base-url http://localhost:3001

# 4. commit (see "Sign-off" below) and push
# 5. open a PR
```

## Sign-off (Developer Certificate of Origin)

Every commit MUST be signed off. By signing off, you certify that you
wrote the contribution or otherwise have the right to submit it under
the project's license. The full text of the DCO is at
https://developercertificate.org.

Add `-s` to your `git commit`:

```bash
git commit -s -m "feat(spec): clarify reducer ordering"
```

This appends a `Signed-off-by: Your Name <you@example.com>` line to
the commit message. PRs without sign-offs will be asked to amend.

## Commit style

We follow Conventional Commits with these prefixes:

- `feat` — new functionality (spec section, demo, executor feature)
- `fix` — bug fix in code or spec
- `docs` — documentation-only changes
- `chore` — build / tooling / repo hygiene
- `refactor` — rearrangement without behavior change
- `test` — test additions/fixes

Keep subjects imperative and ≤72 chars. Body explains *why* + non-
obvious *how*. Examples in `git log`.

## Reviewing the spec

Spec changes (`SPEC.md`, `server/schemas/*.json`) are the highest-risk
contributions because they affect every implementation. PRs touching
spec semantics will get extra scrutiny. Things we'll ask:

- Does this break existing implementations? (Pre-v1 OK if explicit;
  post-v1 must bump major.)
- Is the change covered by the conformance suite?
- Does at least one reference impl already implement the change so
  the spec isn't ahead of code?

Editorial-only spec PRs (typos, clarifications without semantic
change) can land fast.

## Reporting bugs vs spec ambiguities

- **Bug** = existing impl doesn't match the spec → file under "Bug
  report" issue template
- **Spec ambiguity** = spec is silent or contradictory → file under
  "Spec change" issue template; may become a discussion before code

## Code of conduct

By participating you agree to abide by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions are licensed under
Apache 2.0 (the project license — see [LICENSE](LICENSE)). The Apache
2.0 grant includes both copyright and patent rights from each
contributor.
