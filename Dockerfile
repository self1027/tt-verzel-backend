FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.js ./
COPY src ./src
COPY drizzle ./drizzle
COPY docker ./docker
RUN npm run build \
    && mkdir -p /var/lib/verzel-witness /var/lib/verzel-witness-public \
    && chown node:node /var/lib/verzel-witness /var/lib/verzel-witness-public

USER node
CMD ["node", "dist/server.js"]
