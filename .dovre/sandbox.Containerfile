# Toolchain for Dovre's sandbox runs: built on dovre-sandbox, cached until this file changes.
FROM dovre-sandbox
USER root
# pnpm baked in at the version package.json pins, so runs don't download it through corepack.
RUN corepack disable pnpm && npm install -g pnpm@12.11.2 && pnpm --version
USER agent
