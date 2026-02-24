job "caddy" {
  datacenters = ["dc1"]
  type        = "system"

  group "caddy" {
    network {
      port "http" {
        static = 80
      }

      port "admin" {
        static = 2019
      }
    }

    task "caddy" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/caddy"
        args    = ["run", "--config", "/etc/jonasland3/caddy/Caddyfile", "--adapter", "caddyfile"]
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "consul"
        name     = "caddy"
        port     = "http"

        check {
          type     = "http"
          path     = "/"
          port     = "http"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
