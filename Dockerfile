# Dovre on your own server (docs/SELF-HOST.md). Local mode in a container: behind a sign-in proxy
# at PUBLIC_ORIGIN, with the port published to the host's loopback only (deploy/compose.yaml).

# The agent host and terminals (launcher/): without it, Dovre runs with terminals off.
FROM golang:1.25-bookworm AS launcher
WORKDIR /src
COPY launcher/ ./launcher/
RUN go -C launcher build -trimpath -ldflags '-s -w' -o /out/dovre .

FROM node:24-bookworm-slim
# git: memlet (Bino's memory) installs from GitHub, and worktrees need it at run time.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
COPY --from=launcher /out/dovre ./bin/dovre
RUN mkdir -p data /code && chown -R node:node data /code
USER node
# Inside the container only: compose publishes it as 127.0.0.1:4848 on the host.
ENV LISTEN_HOST=0.0.0.0 PORT=4848 CODE_DIR=/code DOVRE_SUPERVISED=1
EXPOSE 4848
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4848/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/index.ts"]
