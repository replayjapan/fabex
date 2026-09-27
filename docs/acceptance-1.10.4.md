# Fabex 1.10.4 acceptance

Automated gates cover grouped owner questions and recorded-answer binding;
atomic scoped changes, cancellation, expiry and resets; account catalog
pagination/failure; Docs Both default; separate blind drafts, revisions and
verbatim assembly through the real controller lifecycle; and narrow Claude
control authorization without ordinary source-write access.

Live host acceptance (not established by fixtures):

1. Open `/fabex:settings`. Select Models; click between Model, Effort, Apply to
   and Navigation tabs. Use More to page catalog choices, then Cancel; settings
   must be unchanged. Check an applied change and its scope once owner-authorized.
2. Check the model list against the signed-in Codex host. Verify Claude's native
   `/model` picker rather than presenting a fixed Claude list. A lookup failure
   must show an explanation, never substitute recent names.
3. Choose Documentation Both through an owner settings grant if an existing
   explicit preference overrides the new default. Run a small approved document
   cycle with independent drafts. Check labeled output and verbatim contributions;
   confirm one author's revision leaves the other's unchanged.
4. Verify Back/Cancel are clickable, no milestone choice appears without a named
   plan stage, and the typed fallback remains available on hosts without dialogs.

The development sandbox denied the Codex app-server's account-state initialization,
so a successful live model list remains unverified here. The read-only probe did
not request inference or change model preferences. Native tab rendering and the
complete two-model host run still require Claude's acceptance review.
