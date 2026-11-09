FROM node:22-bookworm-slim AS deps

WORKDIR /app
# better-sqlite3 downloads a prebuilt binary, and compiles from source when the
# download fails. These tools make that fallback work. They stay in this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Mount a persistent volume at /data, or registrations are lost on redeploy.
ENV DATABASE_PATH=/data/gms.sqlite
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
