---
name: dependency-update
description: Assesses dependency upgrades across the installed-to-target release range for useful changes, security implications, compatibility, and migrations. Use when choosing or evaluating a package update.
---

# Dependency Update

1. Establish the installed and target versions and the benefit sought from updating. Account for compatibility constraints and affected consumers when choosing the target.
2. Consult primary sources for useful changes, security implications, and breaking changes across the full release range. Distinguish documented changes from assumptions about their effect on local usage. Where sources conflict or leave a consequential gap, identify the question and the evidence needed to resolve it.
3. Trace relevant changes into local usage. Identify required migrations and existing workarounds the update makes removable, including consequences for callers and operating conditions.
4. Recommend whether to adopt the target version, weighing the benefit against migration effort, compatibility, and unresolved risk. List adoption prerequisites and unresolved upgrade risks. State what the available evidence establishes, what still needs verification, and which findings would change the recommendation.
