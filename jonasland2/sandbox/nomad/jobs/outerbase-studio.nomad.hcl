job "outerbase-studio" {
  datacenters = ["dc1"]
  type        = "service"

  group "outerbase-studio" {
    network {
      port "http" {
        static = 19040
      }
    }

    task "outerbase-studio" {
      driver = "raw_exec"
      user   = "node"

      env {
        OUTERBASE_SERVICE_PORT = "${NOMAD_PORT_http}"
        OUTERBASE_SQLITE_PATHS = "/var/lib/jonasland2/events-service.sqlite,/var/lib/jonasland2/orders-service.sqlite"
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/outerbase-iframe-service.ts"]
      }

      service {
        provider = "consul"
        name     = "outerbase-studio"
        port     = "http"
        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "3s"
        }
      }

      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
