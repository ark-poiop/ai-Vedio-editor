FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates \
  && mkdir -p /app/assets \
  && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /app/assets/NotoSansCJK-Regular.ttc \
  && chown -R node:node /app/assets \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json index.html ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node server ./server
COPY --chown=node:node sample-media.svg sample-captions.srt ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=2210

EXPOSE 2210

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:2210/api/llm/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "scripts/serve.mjs"]
