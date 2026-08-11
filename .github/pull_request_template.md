## Summary

Describe the change in 1-3 sentences.

## Change Type

<!-- Select the applicable type(s) by keeping the relevant line(s) -->

- [ ] Bug fix (non-breaking change that fixes a specific issue)
- [ ] Feature (new capability, non-breaking)
- [ ] Refactor (no functional change)
- [ ] Documentation (README, docs/, comments)
- [ ] CI / build (workflows, dependencies, scripts)
- [ ] Security (authorization, data privacy, session isolation, token handling)
- [ ] Database migration (schema change or migration script)

## Threat Model Impact

<!-- If this changes any trust boundary, authorization rule, or attack surface,
     describe what changed and why. If none, write "No change." -->

## Database Migration Impact

<!-- If this adds or changes SQLite schema, describe the migration strategy
     and whether existing databases are affected. If none, write "N/A." -->

## Privacy Impact

<!-- If this changes how message content, user data, or tokens are stored,
     logged, or transmitted, describe the change and its implications. -->

## Testing

Describe what you verified locally. Include:

- Test commands run and their output summary
- Any manual verification performed
- Any new test files added

## Real Test Results

```
# Paste the output of `npm test -- --run` here
```

## Rollback Plan

Describe how to revert this change in production, or write "Revert the commit."

## Checklist

- [ ] I ran `npm run build` and `npm test -- --run`
- [ ] I ran `npm run public-check`
- [ ] I reviewed the diff for tokens, account IDs, and local paths
- [ ] I updated documentation if commands, behavior, or boundaries changed
- [ ] I called out any impact on authorization, session isolation, SQLite schema, or data privacy
- [ ] New module tests cover both success and failure paths
