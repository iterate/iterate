job "otel-collector" {
  datacenters = ["dc1"]
  type        = "service"

  group "otel-collector" {
    network {
      port "grpc" {
        static = 4317
      }

      port "http" {
        static = 4318
      }

      port "health" {
        static = 13133
      }
    }

    task "otel-collector" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/otelcol-contrib"
        args    = ["--config", "/etc/jonasland2/otel-collector/config.yaml"]
      }

      service {
        provider = "consul"
        name = "otel-collector"
        port = "http"
        check {
          type     = "http"
          path     = "/"
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
