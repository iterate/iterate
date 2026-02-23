job "whoami" {
  datacenters = ["dc1"]
  type        = "service"

  group "whoami" {
    count = 2

    network {
      port "http" {}
    }

    service {
      provider = "consul"
      name     = "whoami"
      port     = "http"
      tags     = ["caddy"]

      check {
        type     = "http"
        path     = "/"
        interval = "5s"
        timeout  = "2s"
      }
    }

    task "whoami" {
      driver = "raw_exec"

      config {
        command = "node"
        args    = ["local/server.mjs"]
      }

      template {
        destination = "local/server.mjs"
        data        = <<EOF
import { createServer } from "node:http";

const port = Number(process.env.NOMAD_PORT_http || "3000");
const alloc = (process.env.NOMAD_ALLOC_ID || "unknown").slice(0, 8);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ service: "whoami", alloc, port }));
});

server.listen(port, "0.0.0.0");
EOF
      }

      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}
