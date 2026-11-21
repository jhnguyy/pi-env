# Build entry point for the published Dockerfile target.
#   docker buildx bake image

group "default" {
  targets = ["image"]
}

target "reports" {
  dockerfile      = "Dockerfile"
  target          = "verification-report"
  no-cache-filter = ["verification"]
  output          = ["type=local,dest=.e2e-evidence/verification"]
}

# Interactive builds rerun verification, including after a transient test failure.
target "image" {
  inherits        = ["candidate"]
  no-cache-filter = ["verification"]
}

# CI assembles this only after exporting and accepting fresh verification reports.
target "candidate" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}
