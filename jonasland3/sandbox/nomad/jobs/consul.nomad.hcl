job "consul" {
  datacenters = ["dc1"]
  type        = "system"

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
        command = "/usr/local/bin/consul"
        args = [
          "agent",
          "-dev",
          "-client=0.0.0.0",
          "-bind=127.0.0.1",
          "-ui",
          "-data-dir=/consul-data",
          "-dns-port=${NOMAD_PORT_dns}",
          "-datacenter=dc1",
          "-recursor=8.8.8.8",
          "-recursor=1.1.1.1"
        ]
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
