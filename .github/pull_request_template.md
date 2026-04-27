<!-- Thanks for contributing. A few quick checks before merging. -->

## What this changes

<!-- One paragraph. Why + what. -->

## Type

- [ ] `feat` — new functionality
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `chore` — build / tooling / repo hygiene
- [ ] `refactor` — rearrangement without behavior change
- [ ] `test` — test additions/fixes
- [ ] **Spec change** (`SPEC.md` or `server/schemas/`) — extra scrutiny

## Checklist

- [ ] Commits are signed off (`git commit -s`) per
      [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] Existing tests still pass: `cd server && npm run smoke`
- [ ] Conformance suite still passes:
      `cd conformance && python -m originator.level0 --base-url ...`
- [ ] If this is a spec change: at least one reference impl already
      implements the change, or this PR adds one
- [ ] CHANGELOG.md updated (under `[Unreleased]`)

## Related issues

<!-- Closes #N, refs #M -->
