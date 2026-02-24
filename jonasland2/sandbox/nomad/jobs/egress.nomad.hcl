variable "external_egress_proxy" {
  type    = string
  default = ""
}

job "egress-proxy" {
  datacenters = ["dc1"]
  type        = "service"

  group "egress-proxy" {
    network {
      port "http" {
        static = 19000
      }
    }

    task "egress-proxy" {
      driver = "raw_exec"
      user   = "node"

      env {
        PORT = "${NOMAD_PORT_http}"
        ITERATE_EXTERNAL_EGRESS_PROXY = var.external_egress_proxy
      }

      config {
        command = "/usr/local/bin/node"
        args    = ["/app/egress-server.mjs"]
      }

      service {
        provider = "consul"
        name = "egress-proxy"
        port = "http"
        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 150
        memory = 128
      }
    }
  }
}
