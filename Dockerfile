# ---- build: install all dependencies, generate the Prisma client, compile TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
# Opt out of swagger-ui's install-time telemetry.
ENV SCARF_ANALYTICS=false

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: production dependencies and compiled output only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./

USER node
EXPOSE 3000

# Apply pending migrations, then replace the shell with node so it receives SIGTERM directly.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]
