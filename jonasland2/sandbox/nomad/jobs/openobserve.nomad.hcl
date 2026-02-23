job "openobserve" {
  datacenters = ["dc1"]
  type        = "service"

  group "openobserve" {
    network {
      port "http" {
        static = 5080
      }

      port "grpc" {
        static = 5081
      }
    }

    task "openobserve" {
      driver = "raw_exec"

      env {
        ZO_HTTP_ADDR             = "0.0.0.0"
        ZO_HTTP_PORT             = "${NOMAD_PORT_http}"
        ZO_LOCAL_MODE            = "true"
        ZO_LOCAL_MODE_STORAGE    = "disk"
        ZO_DATA_DIR              = "/var/lib/openobserve"
        ZO_ROOT_USER_EMAIL       = "root@example.com"
        ZO_ROOT_USER_PASSWORD    = "Complexpass#123"
      }

      config {
        command = "/usr/local/bin/openobserve"
      }

      service {
        name = "openobserve"
        port = "http"
        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 800
        memory = 1024
      }
    }
  }
}
