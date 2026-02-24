job "zookeeper-1" {
  datacenters = ["dc1"]
  type        = "service"

  group "zookeeper-1" {
    network {
      port "client" {
        static = 2181
      }

      port "admin" {
        static = 8081
      }

      port "metrics" {
        static = 9141
      }
    }

    task "zookeeper-1" {
      driver = "raw_exec"

      env {
        BITNAMI_APP_NAME              = "zookeeper"
        ALLOW_ANONYMOUS_LOGIN          = "yes"
        ZOO_SERVER_ID                  = "1"
        ZOO_AUTOPURGE_INTERVAL         = "1"
        ZOO_ENABLE_PROMETHEUS_METRICS  = "yes"
        ZOO_PROMETHEUS_METRICS_PORT_NUMBER = "${NOMAD_PORT_metrics}"
        ZOO_ADMIN_SERVER_PORT_NUMBER   = "${NOMAD_PORT_admin}"
      }

      config {
        command = "/opt/bitnami/scripts/zookeeper/entrypoint.sh"
        args    = ["/opt/bitnami/scripts/zookeeper/run.sh"]
      }

      service {
        provider = "consul"
        name     = "zookeeper-1"
        port     = "client"

        check {
          name     = "client-tcp"
          type     = "tcp"
          interval = "10s"
          timeout  = "2s"
        }

        check {
          name     = "admin-http"
          type     = "http"
          path     = "/commands/ruok"
          port     = "admin"
          interval = "10s"
          timeout  = "2s"
        }
      }

      resources {
        cpu    = 300
        memory = 768
      }
    }
  }
}
