job "clickhouse" {
  datacenters = ["dc1"]
  type        = "service"

  group "clickhouse" {
    network {
      port "http" {
        static = 8123
      }

      port "native" {
        static = 9000
      }

      port "interserver" {
        static = 9009
      }
    }

    task "clickhouse" {
      driver = "raw_exec"

      env {
        CLICKHOUSE_RUN_AS_ROOT  = "1"
        CLICKHOUSE_SKIP_USER_SETUP = "1"
        CLICKHOUSE_CONFIG       = "/etc/clickhouse-server/config.xml"
      }

      config {
        command = "/usr/local/bin/clickhouse-entrypoint.sh"
      }

      service {
        provider = "consul"
        name     = "clickhouse"
        port     = "native"

        check {
          type     = "http"
          path     = "/ping"
          port     = "http"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 700
        memory = 3072
      }
    }
  }
}
