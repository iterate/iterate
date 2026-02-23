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
          "/etc/jonasland/scripts/iptables-redirect.sh && printf '%s\n%s\n' 'nameserver 127.0.0.1' 'options ndots:0' > /etc/resolv.conf && exec gosu node caddy run --config /etc/jonasland/caddy/Caddyfile --adapter caddyfile"
        ]
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        provider = "consul"
        name     = "caddy"
        port     = "admin"

        check {
          type     = "tcp"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
