job "home-service" {
  datacenters = ["dc1"]
  type        = "service"

  group "home-service" {
    network {
      port "http" {
        static = 19030
      }
    }

    task "home-service" {
      driver = "raw_exec"
      user   = "node"

      env {
        HOME_SERVICE_PORT                 = "${NOMAD_PORT_http}"
        OTEL_EXPORTER_OTLP_ENDPOINT       = "http://127.0.0.1:15318"
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:15318/v1/traces"
        OTEL_EXPORTER_OTLP_PROTOCOL       = "http/protobuf"
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL  = "http/protobuf"
        OTEL_PROPAGATORS                  = "tracecontext,baggage"
      }

      config {
        command = "/app/node_modules/.bin/tsx"
        args    = ["/app/apps/home-service/src/server.ts"]
      }

      service {
        provider = "consul"
        name = "home-service"
        port = "http"
        check {
          type     = "http"
          path     = "/healthz"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 100
        memory = 96
      }
    }
  }
}
