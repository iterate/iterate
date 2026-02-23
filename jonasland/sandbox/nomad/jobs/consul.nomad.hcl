job "consul" {
  datacenters = ["dc1"]
  type        = "service"

  group "consul" {
    network {
      port "http" {
        static = 8500
      }

      port "dns" {
        static = 8600
      }
    }

    task "consul" {
      driver = "raw_exec"

      config {
        command = "consul"
        args = [
          "agent",
          "-dev",
          "-client=0.0.0.0",
          "-bind=127.0.0.1",
          "-datacenter=dc1"
        ]
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "consul"
        name     = "consul"
        port     = "http"

        check {
          type     = "http"
          path     = "/v1/status/leader"
          interval = "5s"
          timeout  = "2s"
        }
      }
    }
  }
}
