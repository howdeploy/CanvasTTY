# Repository Technical-Debt Issues

This directory stores deferred, independently resumable engineering work close to the code it affects.
It is not a duplicate product tracker and not an archive for every observation.

Create an Issue when evidence proves material work that should not widen the current task. Include a
stable locator, context, root cause or explicit hypothesis, deferral reason, recommended direction,
resume condition, and verification boundary. Add one linked code TODO when a stable seam benefits from
an in-place warning.

## Format

Use a descriptive English kebab-case filename. Write the document as a self-contained bug report or
deferred-work record without tracker metadata in the body; status, priority, assignment, and dates
belong to the issue tracker that imports the document.

Before removing a resolved document, extract unique current behavior, significant decisions, or
repeatable operational knowledge into their canonical owner.
