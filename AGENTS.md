# SignalTrail autonomous development

## Goal and context

Build SignalTrail into a complete, reliable analytics and session-replay product.
The default is autonomous implementation, not a teaching session. Maximize useful,
verified progress within the available usage budget while preserving correctness
and a reviewable commit history.

Read `docs/PROJECT_STATUS.md` and `docs/OPEN_QUESTIONS.md` at session start.
Read `docs/TASKS.md` for the current actionable queue; keep it synchronized when
completing or blocking a slice. Historical “next” entries are not the task queue.
Verify existing milestones rather than repeating completed setup. Product scope
is also described in
`/Users/eufracio/Documents/ChatGPT/Senior/signaltrail-project-plan.md`.
Curriculum documents and interview preparation do not govern project execution;
consult them only when the user explicitly requests teaching or interview work.
Keep project changes within this repository.

## Autonomous working process

- Treat requests such as “continue” or “start the next day” as authorization to
  resume the recorded plan. Briefly state the next slice and start; do not ask
  for daily scope approval or routine implementation decisions.
- Edit files and run verification directly. Do not require the user to copy code,
  execute commands, answer teach-back questions, or approve each slice.
- Complete a coherent slice, verify it, commit it locally, and continue to the
  next useful slice. A passing check or completed commit is a checkpoint, not a
  reason to stop. Continue while useful authorized work and usage remain, unless
  the user asks to stop or a genuine blocker prevents further progress.
- Do not end a turn merely to announce the next action, request a routine
  “continue,” or reopen a recorded decision. Execute the next authorized step.
  Before declaring a blocker, inspect available configuration and evidence,
  attempt safe alternatives, and continue independent work. Stop only when no
  useful authorized work can proceed without a specific required user input,
  external change, or permission; state that exact dependency and record it.
- Make regular local commits after verified slices. Stage only relevant files;
  preserve unrelated user changes. Do not claim unrun checks or incomplete work
  as passing or completed.
- Use judgment for reversible design choices consistent with recorded decisions.
  Avoid speculative rewrites or unrelated work merely to consume usage.
- Give concise progress updates explaining outcomes, material decisions, and
  remaining uncertainty. Teach only when requested; routine progress does not
  depend on a lesson, quiz, or user response.
- Maintain project status and the question log as part of the work without
  requiring a separate documentation request. Before stopping, record completed
  work, actual verification, limitations, and the exact next step durably.
- User requests to stop take precedence. Finish or safely leave the current work,
  clean up owned test resources, record the checkpoint, and stop.

## Unanswered questions and boundaries

- Use `docs/OPEN_QUESTIONS.md` as the durable queue of questions for the user.
  Record the decision needed, why it matters, any reversible working assumption,
  and when an answer becomes necessary. Update or resolve entries as evidence or
  user answers arrive; avoid duplicate questions.
- Do not interrupt for questions that can be deferred. Proceed with independent
  work or a documented reversible default while awaiting the user's review.
- If a decision would require an irreversible commitment, spending money,
  changing credentials, publishing, deploying, pushing commits, sending messages,
  or altering external resources, do not assume authorization. Record the issue
  and continue other useful work unless the session already authorizes it.
- Existing sandbox and tool approval requirements still apply; these instructions
  do not bypass them. Reuse saved approvals and request only necessary escalation.
- Run failure/load scenarios against isolated test infrastructure. Do not disrupt
  the user's development services or remove their persistent volumes.

## Verification

- Use test-first development for meaningful behavior changes: write and run the
  test, inspect the intended failure, implement, and verify. The agent performs
  the cycle without waiting for the user between steps.
- Distinguish setup/import failures from failures of the intended behavior.
- Run checks appropriate to the change. Reuse passing evidence when unchanged
  code and resolved concerns do not justify repeating expensive tests.
- Separate local test evidence from production guarantees and remote CI results.
  Record provisional limits and evidence gaps rather than overstating readiness.

## Operational commands

- Use the `signaltrail-operations` skill for checks, browser/broker tests,
  load tests, and monitoring.
- Use `scripts/signaltrail-ops.mjs` for every operation it covers.
- Do not recreate covered operations with ad hoc shell commands.
- Focused TDD tests and ordinary file inspection/editing are exceptions.
- If a needed operation is missing, explain the gap before using an ad hoc
  command; extend the runner when the operation should be reusable.
- Reuse existing approvals. The runner does not bypass sandbox permissions.
