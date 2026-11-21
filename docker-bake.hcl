group "default" {
  targets = ["image"]
}

target "test" {
  dockerfile = "Dockerfile"
  target     = "test"
  tags       = ["pi-env:test"]
}

target "image" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}
