job "cpm" {
  datacenters = ["dc1"]
  type        = "system"

  group "cpm" {
    network {
      port "http" {
        static = 8501
      }
    }

    task "cpm" {
      driver = "raw_exec"

      config {
        command = "/usr/local/bin/run-cpm"
      }

      env {
        HOST              = "0.0.0.0"
        PORT              = "${NOMAD_PORT_http}"
        CADDY_CONFIG_PATH = "/etc/jonasland3/cpm-config"
        CADDY_DATA_PATH   = "/etc/jonasland3/cpm-data"
        CONTAINER_NAME    = "caddy"
        DEFAULT_IP        = "127.0.0.1"
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "consul"
        name     = "cpm"
        port     = "http"

        check {
          type     = "tcp"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
