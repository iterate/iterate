job "caddy" {
  datacenters = ["dc1"]
  type        = "system"

  group "caddy" {
    network {
      port "http" {
        static = 80
      }

      port "https" {
        static = 443
      }

      port "admin" {
        static = 2019
      }
    }

    task "caddy" {
      driver = "raw_exec"

      env {
        OTEL_SERVICE_NAME            = "jonasland2-caddy"
        OTEL_EXPORTER_OTLP_ENDPOINT  = "http://127.0.0.1:4317"
        OTEL_EXPORTER_OTLP_PROTOCOL  = "grpc"
        OTEL_EXPORTER_OTLP_INSECURE  = "true"
        OTEL_PROPAGATORS             = "tracecontext,baggage"
      }

      config {
        command = "/usr/local/bin/caddy"
        args    = ["run", "--config", "/etc/jonasland2/caddy/Caddyfile", "--adapter", "caddyfile"]
      }

      service {
        provider = "consul"
        name = "caddy"
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
        memory = 128
      }
    }
  }
}
