job "caddymanager" {
  datacenters = ["dc1"]
  type        = "system"

  group "caddymanager" {
    network {
      port "backend" {
        static = 3000
      }

      port "ui" {
        static = 8501
      }
    }

    task "backend" {
      driver = "raw_exec"

      config {
        command = "/etc/jonasland3/scripts/run-caddymanager-backend.sh"
      }

      env {
        PORT                    = "${NOMAD_PORT_backend}"
        DB_ENGINE               = "sqlite"
        SQLITE_DB_PATH          = "/caddymanager-data/caddymanager.sqlite"
        CORS_ORIGIN             = "*"
        CADDY_SANDBOX_URL       = "http://127.0.0.1:2019"
        JWT_SECRET              = "jonasland3-local-dev-secret"
        JWT_EXPIRATION          = "24h"
        PING_INTERVAL           = "2000"
        PING_TIMEOUT            = "1000"
        AUDIT_LOG_MAX_SIZE_MB   = "20"
        AUDIT_LOG_RETENTION_DAYS = "7"
      }

      resources {
        cpu    = 100
        memory = 256
      }

      service {
        provider = "consul"
        name     = "caddymanager-backend"
        port     = "backend"

        check {
          type     = "http"
          path     = "/api/v1/health"
          port     = "backend"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }

    task "frontend" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/caddy"
        args    = ["run", "--config", "/etc/jonasland3/caddymanager/Caddyfile", "--adapter", "caddyfile"]
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "consul"
        name     = "caddymanager-ui"
        port     = "ui"

        check {
          type     = "http"
          path     = "/"
          port     = "ui"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
