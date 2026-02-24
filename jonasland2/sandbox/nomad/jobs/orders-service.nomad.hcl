job "orders-service" {
  datacenters = ["dc1"]
  type        = "service"

  group "orders-service" {
    network {
      port "http" {
        static = 19020
      }
    }

    task "orders-service" {
      driver = "raw_exec"
      user   = "node"

      env {
        ORDERS_SERVICE_PORT                = "${NOMAD_PORT_http}"
        EVENTS_SERVICE_BASE_URL            = "http://events-service.service.consul:19010/api"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:5080/api/default/v1/traces"
        OTEL_EXPORTER_OTLP_HEADERS         = "Authorization=Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="
        OTEL_CORRELATED_LOGS_ENDPOINT      = "http://127.0.0.1:5080/api/default/orpc_logs/_json"
        OTEL_CORRELATED_LOGS_HEADERS       = "Authorization=Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/apps/orders-service/src/server.ts"]
      }

      service {
        name = "orders-service"
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
