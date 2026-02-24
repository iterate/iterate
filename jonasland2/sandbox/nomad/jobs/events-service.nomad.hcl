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
        EVENTS_DB_PATH                      = "/var/lib/jonasland2/events-service.sqlite"
        OTEL_EXPORTER_OTLP_ENDPOINT         = "http://127.0.0.1:15318"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  = "http://127.0.0.1:15318/v1/traces"
        OTEL_EXPORTER_OTLP_PROTOCOL        = "http/protobuf"
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL   = "http/protobuf"
        OTEL_PROPAGATORS                   = "tracecontext,baggage"
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/apps/events-service/src/server.ts"]
      }

      service {
        provider = "consul"
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
