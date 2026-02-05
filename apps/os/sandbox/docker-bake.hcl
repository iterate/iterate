// Docker Bake file for sandbox image
// Using bake instead of build for more efficient --load (only transfers missing layers)

variable "GIT_SHA" {
  default = "unknown"
}

variable "PLATFORM" {
  default = "linux/amd64"
}

variable "IMAGE_NAME" {
  default = "iterate-sandbox:local"
}

variable "BUILT_BY" {
  default = "unknown"
}

variable "MINIMAL_GIT_DIR" {
  default = ".git"
}

target "sandbox" {
  dockerfile = "apps/os/sandbox/Dockerfile"
  platforms = [PLATFORM]
  tags = [IMAGE_NAME]
  args = {
    GIT_SHA = GIT_SHA
  }
  labels = {
    "com.iterate.built_by" = BUILT_BY
  }
  contexts = {
    iterate-synthetic-git = MINIMAL_GIT_DIR
  }
}

group "default" {
  targets = ["sandbox"]
}
