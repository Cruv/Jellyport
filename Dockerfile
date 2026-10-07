FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY frontend ./frontend
RUN npm run build

FROM node:24-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/Cruv/Jellyport" \
      org.opencontainers.image.description="Jellyport - Emby to Jellyfin account and watched status migration"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    groupadd --system --gid 10001 jellyport && \
    useradd --system --uid 10001 --gid 10001 --create-home jellyport && \
    mkdir /data && chown jellyport:jellyport /data
COPY --from=build /app/dist ./dist
USER jellyport
ENV NODE_ENV=production JELLYPORT_DATA_DIR=/data HOST=0.0.0.0 PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"
CMD ["node", "dist/server/index.js"]
