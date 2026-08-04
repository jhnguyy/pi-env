{{- range . }}
  {{- $target := .Target }}
  {{- range .Vulnerabilities }}
VULNERABILITY {{ .Severity }} {{ .VulnerabilityID }} | package={{ .PkgName }} | installed={{ .InstalledVersion }} | fixed={{ .FixedVersion }} | target={{ $target }}
  {{- end }}
  {{- range .Secrets }}
SECRET {{ .Severity }} {{ .RuleID }} | title={{ .Title }} | target={{ $target }}
  {{- end }}
  {{- range .Misconfigurations }}
MISCONFIGURATION {{ .Severity }} {{ .ID }} | title={{ .Title }} | target={{ $target }}
  {{- end }}
{{- end }}
