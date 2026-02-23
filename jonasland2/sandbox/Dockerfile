FROM node:24-alpine

RUN apk add --no-cache caddy curl iptables su-exec

WORKDIR /app
COPY package.json /app/package.json
COPY apps /app/apps
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir -p /app/node_modules/@jonasland2 && \
    ln -sf /app/apps/events-contract /app/node_modules/@jonasland2/events-contract && \
    ln -sf /app/apps/events-service /app/node_modules/@jonasland2/events-service
COPY Caddyfile /app/Caddyfile
COPY egress-server.mjs /app/egress-server.mjs
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh && mkdir -p /var/lib/caddy && chown -R node:node /var/lib/caddy

EXPOSE 80 443 2019 19000 19010
CMD ["/app/start.sh"]
