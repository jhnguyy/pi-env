---
name: jit-catch
description: Runs an exploratory catching experiment for a named behavior in an extension diff. Use when temporary diagnostic evidence would clarify a change.
---

# JIT Catch

Use `testing-practices` for permanent test design and evidence.

Name one observable behavior or failure, then use `jit_catch` to generate and run the smallest focused experiment that can observe it. Catching tests are exploratory diagnostics: they are removed on success and retained on failure or interruption for inspection.

Do not treat a catching test as post-hoc justification or promote it into permanent coverage. Derive any lasting regression, requirement, or safety test independently under repository testing policy.
