job "events-service" {
  datacenters = ["dc1"]
  type        = "service"

  group "events-service" {
    network {
      port "http" {
        static = 19010
      }
    }

    task "events-service" {
      driver = "raw_exec"
      user   = "node"

      env {
        EVENTS_SERVICE_PORT                 = "${NOMAD_PORT_http}"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:5080/api/default/v1/traces"
        OTEL_EXPORTER_OTLP_HEADERS         = "Authorization=Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/apps/events-service/src/server.ts"]
      }

      service {
        name = "events-service"
        port = "http"
        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 300
        memory = 256
      }
    }
  }
}
