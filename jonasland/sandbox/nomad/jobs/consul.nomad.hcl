job "consul" {
  datacenters = ["dc1"]
  type        = "service"

  group "consul" {
    network {
      port "http" {
        static = 8500
      }

      port "dns" {
        static = 53
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
          "-dns-port=${NOMAD_PORT_dns}",
          "-recursor=8.8.8.8",
          "-recursor=1.1.1.1",
          "-datacenter=dc1"
        ]
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        provider = "nomad"
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
