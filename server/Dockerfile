FROM node:22-alpine
WORKDIR /app

# ffmpeg: encoder / dropChecker. tini: clean SIGTERM propagation so the
# server's shutdown handler drains pg-boss + active recordings.
RUN apk add --no-cache ffmpeg tini

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
# db:push (not db:migrate) because the drizzle journal is not kept in lock-step
# with the latest SQL files — push reconciles the live schema against
# src/db/schema.ts directly, which is idempotent and safe to run on every boot.
CMD ["sh", "-c", "npx drizzle-kit push --force && npm run start"]
