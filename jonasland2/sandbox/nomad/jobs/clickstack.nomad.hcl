job "clickstack" {
  datacenters = ["dc1"]
  type        = "service"

  group "clickstack" {
    network {
      port "http" {
        static = 19050
      }

      port "api" {
        static = 19051
      }
    }

    task "clickstack" {
      driver = "raw_exec"
      user   = "root"

      env {
        HYPERDX_APP_PORT = "${NOMAD_PORT_http}"
        HYPERDX_API_PORT = "${NOMAD_PORT_api}"
        HYPERDX_APP_URL  = "http://clickstack.iterate.localhost"
      }

      config {
        command = "/etc/jonasland2/clickstack-launcher.sh"
      }

      service {
        provider = "consul"
        name     = "clickstack"
        port     = "http"

        check {
          type     = "http"
          path     = "/"
          interval = "15s"
          timeout  = "5s"
        }
      }

      resources {
        cpu    = 1200
        memory = 4096
      }
    }
  }
}
