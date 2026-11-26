{{- range . }}{{ if eq .Target "nub.lock" }}{{ len .Packages }}{{ end }}{{ end -}}
