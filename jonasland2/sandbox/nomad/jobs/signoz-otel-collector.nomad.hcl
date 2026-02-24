job "signoz-otel-collector" {
  datacenters = ["dc1"]
  type        = "service"

  group "signoz-otel-collector" {
    network {
      port "grpc" {
        static = 14317
      }

      port "http" {
        static = 14318
      }

      port "health" {
        static = 14333
      }

      port "pprof" {
        static = 14777
      }
    }

    task "signoz-otel-collector" {
      driver = "raw_exec"

      env {
        OTEL_RESOURCE_ATTRIBUTES                      = "host.name=signoz-host,os.type=linux"
        LOW_CARDINAL_EXCEPTION_GROUPING              = "false"
        SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_DSN         = "tcp://clickhouse.service.consul:9000"
        SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_CLUSTER     = "cluster"
        SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_REPLICATION = "false"
        SIGNOZ_OTEL_COLLECTOR_TIMEOUT                = "10m"
      }

      config {
        command = "/bin/sh"
        args = [
          "-c",
          "set -e; until curl -fsS http://clickhouse.service.consul:8123/ping >/dev/null 2>&1; do sleep 1; done; until /usr/local/bin/signoz-otel-collector migrate bootstrap && /usr/local/bin/signoz-otel-collector migrate sync up && /usr/local/bin/signoz-otel-collector migrate async up && /usr/local/bin/signoz-otel-collector migrate sync check; do sleep 2; done; exec /usr/local/bin/signoz-otel-collector --config=/etc/jonasland2/signoz/otel-collector-config.yaml",
        ]
      }

      service {
        provider = "consul"
        name     = "signoz-otel-collector"
        port     = "http"

        check {
          type     = "http"
          path     = "/"
          port     = "health"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 700
        memory = 1024
      }
    }
  }
}
