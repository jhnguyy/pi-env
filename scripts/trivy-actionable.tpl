{{- $vulnerabilities := 0 }}{{ $secrets := 0 }}{{ $misconfigurations := 0 }}
{{- range . }}
  {{- $vulnerabilities = add $vulnerabilities (len .Vulnerabilities) }}
  {{- $secrets = add $secrets (len .Secrets) }}
  {{- $misconfigurations = add $misconfigurations (len .Misconfigurations) }}
{{- end -}}
Vulnerabilities: {{ $vulnerabilities }} | Secrets: {{ $secrets }} | Misconfigurations: {{ $misconfigurations }}
{{- range . }}
  {{- $target := .Target }}
  {{- range .Vulnerabilities }}
VULNERABILITY {{ .Severity }} {{ .VulnerabilityID }} | package={{ .PkgName }} | installed={{ .InstalledVersion }} | fixed={{ .FixedVersion }} | status={{ .Status }} | target={{ $target }}
  {{- end }}
  {{- range .Secrets }}
SECRET {{ .Severity }} {{ .RuleID }} | title={{ .Title }} | target={{ $target }}
  {{- end }}
  {{- range .Misconfigurations }}
MISCONFIGURATION {{ .Severity }} {{ .ID }} | title={{ .Title }} | target={{ $target }}
  {{- end }}
{{- end }}
