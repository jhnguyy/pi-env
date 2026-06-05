# HTML Artifacts

Use HTML when it keeps the human more in the loop than Markdown would.

## Decision Rule

Use Markdown when the artifact is primarily a durable source of truth.

Use HTML when the artifact needs one or more of:

- visual comparison across options
- diagrams, SVG, layout, or spatial reasoning
- annotated diffs or code walkthroughs
- dense reports that benefit from navigation, cards, tabs, or color
- mockups or prototypes
- a small purpose-built editor for one task

If unsure, make the canonical note Markdown and create HTML as a sidecar.

## Good HTML Sidecars

Good sidecars are easy to open, read once, and use for a decision. They often include:

- short executive summary
- visual map, diagram, or comparison grid
- cited evidence or source snippets
- clear tradeoffs
- final recommendation or exportable summary

Store sidecars according to local policy. If no policy exists, ask before writing generated HTML.

## Interactive HTML

Interactive HTML is for tightening the human-agent loop: triage, tune, sort, annotate, or transform data visually.

Every interactive artifact must provide an export path:

- copy as Markdown
- copy as JSON
- copy diff
- copy prompt
- copy final ordering / selected rows / annotations

The exported result should be suitable to paste back into pi or commit to a normal file.

## HTML in Markdown Notes

If local notes render Markdown with sanitized HTML, inline HTML can be useful for:

- small color/status spans
- `<details>/<summary>` for optional context
- simple inline SVG diagrams
- complex tables
- hidden agent comments

Avoid making HTML the primary content inside a durable Markdown note unless local policy says it is searchable and maintainable.

## Avoid

- script-heavy artifacts without user approval
- external dependencies unless necessary
- visual complexity that hides the answer
- HTML files with no Markdown summary when future retrieval matters
- interactive editors that cannot export the user's work
