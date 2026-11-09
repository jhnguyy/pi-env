# Analyze

## On-demand investigations

Routine verification does not run Analyze. Use the existing pattern checks and lint rules for precise, recurring mistakes; use conventions for decisions that require context. Select Analyze when investigating a specific question rather than treating every analyzer as a contribution gate.

Run investigations individually in an environment with adequate capacity. Type similarity builds a TypeScript program, and external checks can launch additional processes. Diff scope limits reported findings but does not guarantee that a semantic analyzer loads only changed files. Supervision and serial execution do not guarantee aggregate memory containment.

```bash
# Inspect duplicate functions introduced or touched by the current delta.
nub run check:duplicates:changed

# Inspect repeated scans in loops touched by the current delta.
nub run check:async-risk:changed
```

These commands retain their existing exit thresholds. The repeated-scan check is heuristic: it does not prove quadratic complexity. Other capabilities remain available through `nub run analyze --help`; avoid an unselected full analysis when only one check is needed.

## Diagnostics

Analyze keeps a bounded local NDJSON journal under `$XDG_STATE_HOME/pi-env/analyze`, or `~/.local/state/pi-env/analyze` when that variable is absent. It provides diagnostic context for worker failures. Set `PI_ENV_ANALYZE_JOURNAL_DIR` to choose another location or `PI_ENV_ANALYZE_JOURNAL_ENABLED=false` to disable it. Preserve relevant failure evidence before later runs rotate it, and review journals before sharing them.

Trace export is off by default. It requires both `PI_ENV_ANALYZE_OTEL_ENABLED=true` and `PI_ENV_ANALYZE_OTEL_ENDPOINT` pointing to the intended OTLP collector. The endpoint is not emitted as telemetry.
