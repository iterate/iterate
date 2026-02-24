export default {
  http: {
    host: "0.0.0.0",
    port: 9876,
  },
  logDir: "/var/log/pidnap",
  processes: [
    {
      name: "caddy",
      definition: {
        command: "/usr/local/bin/caddy",
        args: ["run", "--config", "/etc/jonasland5/caddy/Caddyfile", "--adapter", "caddyfile"],
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
    {
      name: "services",
      definition: {
        command: "/opt/jonasland5-services/node_modules/.bin/tsx",
        args: ["/opt/jonasland5-services/services/services-service.ts"],
      },
      options: {
        restartPolicy: "always",
      },
      envOptions: {
        reloadDelay: false,
      },
    },
  ],
};
