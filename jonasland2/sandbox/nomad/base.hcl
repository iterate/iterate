data_dir = "/nomad-data"
bind_addr = "0.0.0.0"
log_level = "INFO"

addresses {
  http = "0.0.0.0"
  rpc  = "0.0.0.0"
  serf = "0.0.0.0"
}

advertise {
  http = "127.0.0.1:4646"
  rpc  = "127.0.0.1:4647"
  serf = "127.0.0.1:4648"
}

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled           = true
  network_interface = "eth0"
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
