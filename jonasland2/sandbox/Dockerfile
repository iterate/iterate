FROM node:24-alpine

RUN apk add --no-cache curl

WORKDIR /app
COPY egress-server.mjs /app/egress-server.mjs

EXPOSE 19000
CMD ["node", "/app/egress-server.mjs"]
