FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Toolchain so better-sqlite3 can compile from source if no prebuilt binary is available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Mount a persistent volume at /data, or registrations are lost on redeploy.
ENV DATABASE_PATH=/data/gms.sqlite
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
