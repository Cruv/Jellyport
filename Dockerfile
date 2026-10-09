FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY frontend ./frontend
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
LABEL org.opencontainers.image.source="https://github.com/Cruv/Jellyport" \
      org.opencontainers.image.description="Jellyport - Emby to Jellyfin account, progress, favorites and playlist migration"
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && \
    apt-get upgrade --yes --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    npm ci --omit=dev --ignore-scripts && \
    rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* /root/.npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg && \
    groupadd --system --gid 10001 jellyport && \
    useradd --system --uid 10001 --gid 10001 --create-home jellyport && \
    mkdir /data /work && chown jellyport:jellyport /data /work
# Includes the optional network-isolated snapshot-helper entry point.
COPY --from=build /app/dist ./dist
RUN find dist node_modules -type f -name '*.map' -delete
USER jellyport
ENV NODE_ENV=production JELLYPORT_DATA_DIR=/data HOST=0.0.0.0 PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"
CMD ["node", "dist/server/index.js"]
