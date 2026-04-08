# WebSocket 릴레이 (mp-server) — Fly.io / Railway / Render 등
FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server/mp-server.mjs ./
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "mp-server.mjs"]
