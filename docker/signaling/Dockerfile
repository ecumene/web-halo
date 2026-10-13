# Local signaling service (services/signaling), run with `wrangler dev`: the
# Workers runtime (workerd) with Durable Objects, KV and rate limits simulated
# on this machine. Nothing is deployed to Cloudflare.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY . .
COPY --from=docker docker-entrypoint.sh /usr/local/bin/halo-signaling
RUN mkdir /data && chown -R node:node /app /data

USER node
ENV WRANGLER_SEND_METRICS=false
EXPOSE 8787
ENTRYPOINT ["halo-signaling"]
