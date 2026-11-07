FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Mount a persistent volume at /data, or registrations are lost on redeploy.
ENV DATABASE_PATH=/data/gms.sqlite
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
