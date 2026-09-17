# CI trace outcomes and layout

Status: starting. The previous trace-links PR is merged; this follow-up fixes the failed-run summary, planning-job order and clipped labels.

- [ ] Show **Time to red** for failed workflows, measured from workflow execution start to the first failed job completion. Do not count a retried test attempt as a red workflow. Keep any earlier green milestone in the trace evidence.
- [ ] Put the planning job first, while retaining stable grouping of parallel test jobs and cleanup last.
- [ ] Give span labels enough vertical space for descenders without losing horizontal ellipsis.
- [ ] Verify with the reported failed workflow `hjrrdf5flj`, focused assembly tests and browser checks; also check a successful report.

Assumptions: Depot's failed job completion timestamp is the available failure signal; if no failed job timestamp exists, use failed workflow completion and say so. Cancellation alone is not failure. Scope is report generation and presentation, with no CI scheduling or test-policy changes.

## Implementation log

- User report: failed trace says “Not recorded / Time to green”; plan appears below tests; the descender in “plan” is clipped. Screenshot artifact: `01a0afad-84c7-7cc0-aeff-14e60fe36f85`.
