# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM --platform=$BUILDPLATFORM golang:1.26.6-alpine3.23@sha256:e57c41c1d5864341031181b0db34b9a537bb5773eb6428e4e5bdaea0f9135406 AS builder

ARG BUILDPLATFORM
ARG TARGETOS
ARG TARGETARCH
ARG SOURCE_COMMIT=e2eee6a7fce366321294c9c2a79f3146891dcbdf
ARG CADDY_VERSION=v2.11.4
ARG CEL_GO_VERSION=v0.30.0
ARG OTEL_VERSION=v1.44.0
ARG GRPC_VERSION=v1.82.1
ARG X_TEXT_VERSION=v0.40.0
ARG CEL_GO_COMPAT_PATCH_SHA256=570cce32fcd6f674cd5576f4889ac6ab1e0e810816d80229edb071a37d7f413e
ARG CA_CERTIFICATES_VERSION=20260611-r0
ARG GIT_VERSION=2.52.0-r0

COPY patches/cel-go-v0.29-compat.patch /tmp/cel-go-v0.29-compat.patch

RUN apk add --no-cache "ca-certificates=${CA_CERTIFICATES_VERSION}" "git=${GIT_VERSION}"
WORKDIR /src
RUN git init \
    && git remote add origin https://github.com/caddyserver/caddy.git \
    && git fetch --depth 1 origin "${SOURCE_COMMIT}" "refs/tags/${CADDY_VERSION}:refs/tags/${CADDY_VERSION}" \
    && git checkout --detach "${SOURCE_COMMIT}" \
    && test "$(git rev-parse HEAD)" = "${SOURCE_COMMIT}" \
    && test "$(git rev-list -n 1 "${CADDY_VERSION}^{commit}")" = "${SOURCE_COMMIT}" \
    && printf '%s  %s\n' "${CEL_GO_COMPAT_PATCH_SHA256}" /tmp/cel-go-v0.29-compat.patch | sha256sum -c - \
    && git apply --check /tmp/cel-go-v0.29-compat.patch \
    && git apply /tmp/cel-go-v0.29-compat.patch \
    && git diff --check
RUN go get \
      "github.com/google/cel-go@${CEL_GO_VERSION}" \
      "go.opentelemetry.io/otel@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/metric@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/trace@${OTEL_VERSION}" \
      "google.golang.org/grpc@${GRPC_VERSION}" \
      "golang.org/x/text@${X_TEXT_VERSION}" \
    && go mod tidy \
    && go test \
      ./caddyconfig/... \
      ./cmd/... \
      ./modules/caddyhttp/...
RUN mkdir /build \
    && cp cmd/caddy/main.go /build/main.go
WORKDIR /build
RUN go mod init caddy \
    && go mod edit -require="github.com/caddyserver/caddy/v2@${CADDY_VERSION}" \
    && go mod download -json "github.com/caddyserver/caddy/v2@${CADDY_VERSION}" > /tmp/caddy-module.json \
    && grep -Fq "\"Hash\": \"${SOURCE_COMMIT}\"" /tmp/caddy-module.json \
    && go get \
      "github.com/google/cel-go@${CEL_GO_VERSION}" \
      "go.opentelemetry.io/otel@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/metric@${OTEL_VERSION}" \
      "go.opentelemetry.io/otel/trace@${OTEL_VERSION}" \
      "google.golang.org/grpc@${GRPC_VERSION}" \
      "golang.org/x/text@${X_TEXT_VERSION}" \
    && go mod tidy \
    && go mod vendor \
    && cd vendor/github.com/caddyserver/caddy/v2 \
    && git apply --check /tmp/cel-go-v0.29-compat.patch \
    && git apply /tmp/cel-go-v0.29-compat.patch \
    && cd /build \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
      -mod=vendor \
      -trimpath \
      -ldflags "-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=${CADDY_VERSION}-mesh.1" \
      -o /out/caddy main.go \
    && go version -m /out/caddy \
    && mkdir -p /rootfs/config/caddy /rootfs/data/caddy /rootfs/etc/caddy /rootfs/etc/ssl/certs /rootfs/srv /rootfs/usr/share/caddy \
    && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt \
    && printf 'hosts: files dns\n' > /rootfs/etc/nsswitch.conf

COPY Caddyfile /rootfs/etc/caddy/Caddyfile
COPY index.html /rootfs/usr/share/caddy/index.html
RUN chown 65532:65532 /rootfs/config/caddy /rootfs/data/caddy \
    && chmod 0700 /rootfs/config/caddy /rootfs/data/caddy \
    && chown 0:0 /rootfs/etc/caddy/Caddyfile /rootfs/usr/share/caddy/index.html /out/caddy \
    && chmod 0644 /rootfs/etc/caddy/Caddyfile /rootfs/usr/share/caddy/index.html \
    && chmod 0755 /out/caddy

FROM scratch
COPY --from=builder /rootfs/ /
COPY --from=builder /out/caddy /usr/bin/caddy

ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

LABEL org.opencontainers.image.title="Mesh Caddy candidate"
LABEL org.opencontainers.image.version="v2.11.4-mesh.1"
LABEL org.opencontainers.image.source="https://github.com/dhawal-ss/mesh"
LABEL org.opencontainers.image.revision="e2eee6a7fce366321294c9c2a79f3146891dcbdf"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.mesh.image.channel="candidate"

EXPOSE 80 443 2019
EXPOSE 443/udp
WORKDIR /srv
USER 65532:65532
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
