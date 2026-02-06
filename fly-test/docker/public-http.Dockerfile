FROM node:24-alpine

COPY public-http/server.mjs /app/server.mjs

EXPOSE 18090

ENTRYPOINT ["node", "/app/server.mjs"]
