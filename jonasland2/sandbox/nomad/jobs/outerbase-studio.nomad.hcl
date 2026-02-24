job "outerbase-studio" {
  datacenters = ["dc1"]
  type        = "service"

  group "outerbase-studio" {
    network {
      port "http" {
        static = 19040
      }
    }

    task "outerbase-studio" {
      driver = "raw_exec"
      user   = "node"

      env {
        PORT     = "${NOMAD_PORT_http}"
        HOSTNAME = "0.0.0.0"
      }

      config {
        command = "/usr/local/bin/node"
        args    = ["/opt/outerbase/server.js"]
      }

      service {
        provider = "consul"
        name     = "outerbase-studio"
        port     = "http"
        check {
          type     = "http"
          path     = "/"
          interval = "10s"
          timeout  = "3s"
        }
      }

      resources {
        cpu    = 600
        memory = 512
      }
    }
  }
}
