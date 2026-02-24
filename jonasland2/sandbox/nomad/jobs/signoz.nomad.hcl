job "signoz" {
  datacenters = ["dc1"]
  type        = "service"

  group "signoz" {
    network {
      port "http" {
        static = 8080
      }

      port "opamp" {
        static = 4320
      }
    }

    task "signoz" {
      driver = "raw_exec"

      env {
        SIGNOZ_ALERTMANAGER_PROVIDER          = "signoz"
        SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN = "tcp://clickhouse.service.consul:9000"
        SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_CLUSTER = "cluster"
        SIGNOZ_SQLSTORE_SQLITE_PATH           = "/var/lib/signoz/signoz.db"
        SIGNOZ_TOKENIZER_JWT_SECRET           = "secret"
        SIGNOZ_USER_ROOT_ENABLED              = "true"
        SIGNOZ_USER_ROOT_EMAIL                = "root@example.com"
        SIGNOZ_USER_ROOT_PASSWORD             = "Complexpass#123"
        SIGNOZ_STATSREPORTER_ENABLED          = "false"
        SIGNOZ_ANALYTICS_ENABLED              = "false"
      }

      config {
        command = "/usr/local/bin/signoz"
        args    = ["server"]
      }

      service {
        provider = "consul"
        name     = "signoz"
        port     = "http"

        check {
          type     = "http"
          path     = "/api/v1/health"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 800
        memory = 1024
      }
    }
  }
}
