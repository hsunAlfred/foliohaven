FROM node:26.12.1-trixie@sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e AS os-toolchain

ENV DEVCONTAINER_DEBIAN_VERSION=13 \
    DEVCONTAINER_NODE_VERSION=26.12.1 \
    DEVCONTAINER_PNPM_VERSION=12.15.0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    LANG=C.UTF-8

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl ffmpeg git openssh-client ripgrep python3 make g++ util-linux nano \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "pnpm@${DEVCONTAINER_PNPM_VERSION}" \
    && rm -rf /root/.npm

FROM os-toolchain AS toolchain
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
# Change identity while the image home is still small. Package stores, workspace
# dependencies and browsers are created by their final owner in later layers.
RUN case "$LOCAL_UID" in ''|*[!0-9]*) exit 1 ;; esac \
    && case "$LOCAL_GID" in ''|*[!0-9]*) exit 1 ;; esac \
    && test "$LOCAL_UID" -gt 0 && test "$LOCAL_UID" -le 2147483647 \
    && test "$LOCAL_GID" -gt 0 && test "$LOCAL_GID" -le 2147483647 \
    && if [ "$(id -g node)" != "$LOCAL_GID" ]; then groupmod --non-unique --gid "$LOCAL_GID" node; fi \
    && if [ "$(id -u node)" != "$LOCAL_UID" ]; then usermod --non-unique --uid "$LOCAL_UID" node; fi \
    && usermod --gid "$LOCAL_GID" node \
    && chown node:node /home/node \
    && install -d -o node -g node \
      /workspaces/foliohaven \
      /home/node/.local \
      /home/node/.local/share \
      /home/node/.local/share/pnpm \
      /home/node/.local/share/pnpm/store \
      /opt/playwright

USER node
WORKDIR /workspaces/foliohaven

FROM toolchain AS dependencies
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=node:node packages/core/package.json ./packages/core/package.json
COPY --chown=node:node packages/ui/package.json ./packages/ui/package.json
COPY --chown=node:node site/package.json ./site/package.json
COPY --chown=node:node studio/package.json ./studio/package.json
COPY --chown=node:node server/package.json ./server/package.json
# Keep the complete warm store in the image for private offline build snapshots.
RUN pnpm install --frozen-lockfile --prod=false

FROM dependencies AS browser-toolchain
USER root
RUN pnpm exec playwright install-deps chromium firefox webkit
USER node
RUN pnpm exec playwright install chromium firefox webkit

FROM browser-toolchain AS dev
COPY --chown=node:node . .
# The root editor configuration is excluded from context. Recreate only the
# public template so the canonical verification inventory remains complete.
RUN mkdir -p .devcontainer \
    && cp -a release/templates/devcontainer/. .devcontainer/ \
    && pnpm run check:compiler && pnpm run setup
CMD ["pnpm", "dev"]

FROM dev AS verify
ENV CI=true
RUN pnpm verify

FROM dependencies AS builder
COPY --chown=node:node . .
RUN pnpm build

FROM scratch AS dist-export
COPY --from=builder /workspaces/foliohaven/dist/ /

FROM browser-toolchain AS release
ARG RELEASE_VERSION=1.1.0
COPY --chown=node:node . .
ENV FOLIOHAVEN_RELEASE_VERSION=${RELEASE_VERSION}
RUN node --input-type=module -e "import fs from 'node:fs'; if (JSON.parse(fs.readFileSync('package.json')).version !== process.env.FOLIOHAVEN_RELEASE_VERSION) throw new Error('RELEASE_VERSION_MISMATCH')" \
    && pnpm run build:packages \
    && pnpm --filter @foliohaven/server build
USER root
# A fresh bind hides dependencies; preserve the builtin-only bootstrap import layout.
RUN mkdir -p /opt/foliohaven-bootstrap/server/dist/runtime /opt/foliohaven-bootstrap/server/dist/files /opt/foliohaven-bootstrap/scripts \
    && cp server/dist/runtime/lease.js /opt/foliohaven-bootstrap/server/dist/runtime/lease.js \
    && cp server/dist/files/io.js /opt/foliohaven-bootstrap/server/dist/files/io.js \
    && cp scripts/workspace-paths.mjs /opt/foliohaven-bootstrap/scripts/workspace-paths.mjs \
    && printf '%s\n' '{"type":"module"}' > /opt/foliohaven-bootstrap/package.json
USER node
LABEL org.opencontainers.image.version=${RELEASE_VERSION}
CMD ["node", "scripts/start.mjs", "--container"]
