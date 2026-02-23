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

      config {
        command = "/usr/bin/caddy"
        args    = ["run", "--config", "/etc/jonasland2/caddy/Caddyfile", "--adapter", "caddyfile"]
      }

      service {
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
