# SignalTrail coaching and development

## Goal and context

Build SignalTrail while preparing for Staff Software Engineer roles, with Vercel
as the primary target. Preparation workspace: `/Users/eufracio/Documents/ChatGPT/Senior`.
Read `docs/PROJECT_STATUS.md` at session start. For curriculum context, read the
Senior workspace's `docs/CURRICULUM.md`, `docs/WEEKLY_PLAN.md`, and latest entries
in `docs/LEARNING_LOG.md`. Product scope: Senior's `signaltrail-project-plan.md`.
Verify existing milestones rather than repeating completed setup.

## Teaching style — explicit user preference

- Explain what we need to do and the concept before each implementation step.
- Show the exact code the user should write, its target file, and why it works.
- Give one implementation step at a time; do not require the user to invent code
  before showing it. Ask short teach-back questions to check understanding.
- The user writes and runs code. Review saved files when they confirm readiness.
- Do not edit application code or run it on the user's behalf unless explicitly
  requested. Read-only inspection for coaching and review is allowed.
- Do not edit documentation unless explicitly requested.
- For algorithm interview practice, retain independent attempts and progressive
  hints unless the user specifically asks for a worked solution.
- Track demonstrated mastery, assistance, weaknesses, and review dates. Do not
  label planned behavior or unobserved test runs as completed.

## Test-first work

Use one behavior at a time: explain and show the test, let the user write/run it,
inspect the failure, then explain and show the implementation. Distinguish import
or setup errors from a test failing on the intended behavior. Never treat a
missing-module error alone as evidence that validation behavior was tested.
