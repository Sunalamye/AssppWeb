# Pin the protocol engine; do not build a moving upstream branch.
FROM golang:1.26.5-bookworm AS proof-build
ARG IPATOOL_REVISION=3b02b4c55576562f2a55284cda9db9a4411d3067
RUN git clone --filter=blob:none --no-checkout https://github.com/majd/ipatool.git /src/ipatool \
    && git -C /src/ipatool checkout --detach "$IPATOOL_REVISION" \
    && test "$(git -C /src/ipatool rev-parse HEAD)" = "$IPATOOL_REVISION"
WORKDIR /src/ipatool
COPY proof-helper/*.go ./tools/asspp-proof/
RUN go test ./tools/asspp-proof \
    && go build -trimpath -ldflags='-s -w' -o /out/asspp-proof ./tools/asspp-proof
# Download and verify public runtime assets during the build, not during login.
# No Apple account or device provisioning is performed by --prepare.
ENV XDG_CACHE_HOME=/opt/asspp-cache
RUN /out/asspp-proof --prepare

# Build frontend
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build backend with the same libc as the native proof helper.
FROM node:22-bookworm-slim AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Cache the official proof toolchain separately from application source changes.
FROM node:22-bookworm-slim AS lean-build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates zstd \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/install-lean.sh /tmp/install-lean.sh
RUN sh /tmp/install-lean.sh /opt/lean

# A required gate for both Cloudflare's Docker build and ordinary Docker builds.
# The final COPY from this stage makes BuildKit execute it; an unreferenced
# optional stage would be skipped and could not prevent publishing bad source.
FROM backend-build AS verification
WORKDIR /verification
COPY --from=proof-build /usr/local/go /usr/local/go
COPY --from=lean-build /opt/lean /opt/lean
ENV PATH="/opt/lean/bin:/usr/local/go/bin:${PATH}"
COPY package*.json ./
RUN npm ci
COPY --from=frontend-build /app/frontend/node_modules ./frontend/node_modules
COPY --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY . ./
RUN npm run verify

# Runtime
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package.json ./
COPY --from=frontend-build /app/frontend/dist ./public
COPY --from=proof-build /out/asspp-proof /usr/local/bin/asspp-proof
COPY --from=proof-build /opt/asspp-cache /opt/asspp-cache
COPY --from=proof-build /src/ipatool/LICENSE ./licenses/ipatool-LICENSE
COPY container/start.mjs ./container/start.mjs
COPY --from=verification /verification/formal/.lake/verification/verified.json ./formal-verification.json
RUN mkdir -p /data/packages
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE XDG_CACHE_HOME=/opt/asspp-cache
CMD ["node", "container/start.mjs"]
