FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# No npm dependencies: only Node's standard library is used.
COPY package.json ./
COPY server ./server
COPY public ./public

# The checkout WebManager builds from can have owner-only permissions, and
# COPY keeps them, so the non-root user couldn't read the code. Make the app
# readable (but not writable) by everyone, and /data writable by the app.
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1
CMD ["node", "server/server.js"]
