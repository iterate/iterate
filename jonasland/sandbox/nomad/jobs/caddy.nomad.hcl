job "caddy" {
  datacenters = ["dc1"]
  type        = "service"

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
        command = "sh"
        args = [
          "-ec",
          "/etc/jonasland/scripts/iptables-redirect.sh && exec caddy-with-consul run --resume --config /etc/jonasland/caddy/bootstrap.caddyfile --adapter caddyfile"
        ]
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        provider = "consul"
        name     = "caddy"
        port     = "http"

        check {
          type     = "http"
          path     = "/healthz"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
