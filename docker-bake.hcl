# Build entry point for the published Dockerfile target.
#   docker buildx bake image

group "default" {
  targets = ["image"]
}

target "image" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}
