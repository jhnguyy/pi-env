# Analyze diagnostics

Analyze keeps a bounded local NDJSON journal under `$XDG_STATE_HOME/pi-env/analyze`, or `~/.local/state/pi-env/analyze` when that variable is absent. It provides diagnostic context for worker failures. Set `PI_ENV_ANALYZE_JOURNAL_DIR` to choose another location or `PI_ENV_ANALYZE_JOURNAL_ENABLED=false` to disable it. Preserve relevant failure evidence before later runs rotate it, and review journals before sharing them.

Trace export is off by default. It requires both `PI_ENV_ANALYZE_OTEL_ENABLED=true` and `PI_ENV_ANALYZE_OTEL_ENDPOINT` pointing to the intended OTLP collector. The endpoint is not emitted as telemetry.
