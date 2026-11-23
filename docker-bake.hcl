group "default" {
  targets = ["image"]
}

target "image" {
  dockerfile = "Dockerfile"
  target     = "pi-env"
  tags       = ["pi-env:local"]
}
