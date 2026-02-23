job "egress" {
  datacenters = ["dc1"]
  type        = "service"

  group "egress" {
    network {
      port "http" {
        static = 19000
      }
    }

    task "egress" {
      driver = "raw_exec"

      env {
        ITERATE_EGRESS_PORT = "${NOMAD_PORT_http}"
      }

      config {
        command = "node"
        args    = ["/etc/jonasland/services/egress-server.js"]
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "consul"
        name     = "egress"
        port     = "http"

        check {
          type     = "http"
          path     = "/healthz"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
