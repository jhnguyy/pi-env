group "default" {
  targets = ["image"]
}

target "verification" {
  dockerfile = "Dockerfile"
  target     = "verification"
  tags       = ["pi-env:verification"]
}

target "image" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}
