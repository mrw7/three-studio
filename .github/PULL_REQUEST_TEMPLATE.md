## Summary

<!-- What changes, and why? Link the issue if there is one. -->

## User-visible effect

<!-- What will a user see or be able to do differently? -->

## Tests

<!-- Paste the relevant output. `npm test` is the baseline. -->

## Security impact

<!-- Does this touch the sandbox, credentials, API routes, plugin boundaries,
     path handling, network egress or share/export data? If yes, describe the
     review and the regression test. If no, say "none". -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) under the DCO 1.1.
- [ ] AI assistance is disclosed, if any.
- [ ] `npm test` passes (or the skipped reason is explained).
- [ ] README/docs and the Chinese counterparts are updated when a surface changes.
- [ ] No secrets, user sessions or `~/.three-studio` data are included.
- [ ] The scene iframe sandbox remains `allow-scripts allow-pointer-lock allow-downloads` only.
