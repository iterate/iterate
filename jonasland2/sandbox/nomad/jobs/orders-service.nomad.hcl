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
        ORDERS_DB_PATH                     = "/var/lib/jonasland2/orders-service.sqlite"
        EVENTS_SERVICE_BASE_URL            = "http://events-service.service.consul:19010/orpc"
        OTEL_EXPORTER_OTLP_ENDPOINT       = "http://127.0.0.1:4318"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces"
        OTEL_EXPORTER_OTLP_PROTOCOL        = "http/protobuf"
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL   = "http/protobuf"
        OTEL_PROPAGATORS                   = "tracecontext,baggage"
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/apps/orders-service/src/server.ts"]
      }

      service {
        provider = "consul"
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
