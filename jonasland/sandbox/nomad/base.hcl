data_dir = "/var/lib/nomad"
bind_addr = "0.0.0.0"
log_level = "INFO"

addresses {
  http = "0.0.0.0"
  rpc  = "0.0.0.0"
  serf = "0.0.0.0"
}

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled = true
  options = {
    "driver.raw_exec.enable" = "1"
  }
}

ports {
  http = 4646
  rpc  = 4647
  serf = 4648
}

consul {
  address = "127.0.0.1:8500"
}
