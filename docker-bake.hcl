# Build and test entry points for the Dockerfile targets.
#   docker buildx bake image
#   docker buildx bake session-manager-e2e-evidence && docker buildx bake session-manager-e2e

variable "PI_ENV_REVISION" {
  default = "unknown"
}

variable "PI_ENV_E2E_ARTIFACT_DIR" {
  default = ".e2e-evidence/session-manager"
}

group "default" {
  targets = ["image"]
}

target "image" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}

target "_session-manager-e2e" {
  dockerfile = "Dockerfile"
  args = {
    PI_ENV_REVISION = PI_ENV_REVISION
  }
}

# Always succeeds once the test has run, so evidence is exported on failure too.
target "session-manager-e2e-evidence" {
  inherits = ["_session-manager-e2e"]
  target   = "session-manager-e2e-evidence"
  output   = ["type=local,dest=${PI_ENV_E2E_ARTIFACT_DIR}"]
}

# Reuses the cached test run and fails when the E2E failed.
target "session-manager-e2e" {
  inherits = ["_session-manager-e2e"]
  target   = "session-manager-e2e"
  output   = ["type=cacheonly"]
}
