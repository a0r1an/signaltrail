# SignalTrail coaching and development

## Goal and context

Build SignalTrail while preparing for Staff Software Engineer roles, with Vercel
as the primary target. Preparation workspace: `/Users/eufracio/Documents/ChatGPT/Senior`.
Read `docs/PROJECT_STATUS.md` at session start. For curriculum context, read the
Senior workspace's `docs/CURRICULUM.md`, `docs/WEEKLY_PLAN.md`, and latest entries
in `docs/LEARNING_LOG.md`. Product scope: Senior's `signaltrail-project-plan.md`.
Verify existing milestones rather than repeating completed setup.

## Teaching style — explicit user preference

- At the start of each day, propose the scope and ask whether it is correct,
  including any design questions needed before work begins. Wait for approval
  before implementation.
- After scope approval, the agent edits application code and runs checks directly.
  Explain the concepts and design decisions as work progresses; the user does
  not need to copy code or run commands. Ask short teach-back questions when useful.
- Keep changes within the approved scope and verify existing milestones rather
  than repeating completed work.
- Do not edit documentation unless explicitly requested.
- For algorithm interview practice, retain independent attempts and progressive
  hints unless the user specifically asks for a worked solution.
- Track demonstrated mastery, assistance, weaknesses, and review dates. Do not
  label planned behavior or unobserved test runs as completed.

## Test-first work

Use one behavior at a time: explain the behavior, write and run its test, inspect
the intended failure, then implement and verify it. The agent performs these steps
after scope approval. Distinguish import or setup errors from a test failing on
the intended behavior. Never treat a missing-module error alone as evidence that
validation behavior was tested.
