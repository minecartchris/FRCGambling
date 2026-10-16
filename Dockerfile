FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# No npm dependencies: only Node's standard library is used.
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1
CMD ["node", "server/server.js"]
