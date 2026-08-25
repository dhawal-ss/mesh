# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc AS builder

ARG SOURCE_COMMIT=199ac87dbbf704320b277aebdf10a6280b18c77d
ARG RELEASE_VERSION=v0.5.0
ARG CEL_GO_VERSION=v0.29.0
ARG PION_DTLS_VERSION=v3.1.4
ARG PION_STUN_VERSION=v3.1.5
ARG X_NET_VERSION=v0.57.0
ARG X_TEXT_VERSION=v0.40.0
ARG CA_CERTIFICATES_VERSION=20260611-r0
ARG GIT_VERSION=2.52.0-r0

RUN apk add --no-cache "ca-certificates=${CA_CERTIFICATES_VERSION}" "git=${GIT_VERSION}"
WORKDIR /src
RUN git init \
    && git remote add origin https://github.com/element-hq/lk-jwt-service.git \
    && git fetch --depth 1 origin "${SOURCE_COMMIT}" "refs/tags/${RELEASE_VERSION}:refs/tags/${RELEASE_VERSION}" \
    && git checkout --detach "${SOURCE_COMMIT}" \
    && test "$(git rev-parse HEAD)" = "${SOURCE_COMMIT}" \
    && test "$(git rev-list -n 1 "${RELEASE_VERSION}^{commit}")" = "${SOURCE_COMMIT}"
RUN go mod edit -toolchain=go1.26.5 \
    && go get \
      "github.com/google/cel-go@${CEL_GO_VERSION}" \
      "github.com/pion/dtls/v3@${PION_DTLS_VERSION}" \
      "github.com/pion/stun/v3@${PION_STUN_VERSION}" \
      "golang.org/x/net@${X_NET_VERSION}" \
      "golang.org/x/text@${X_TEXT_VERSION}" \
    && go mod tidy \
    && go test ./... \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -buildid=" -o /out/lk-jwt-service . \
    && mkdir -p /rootfs/etc/ssl/certs \
    && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt \
    && printf 'hosts: files dns\n' > /rootfs/etc/nsswitch.conf
RUN chown 0:0 /out/lk-jwt-service \
    && chmod 0755 /out/lk-jwt-service

FROM scratch
COPY --from=builder /rootfs/ /
COPY --from=builder /out/lk-jwt-service /lk-jwt-service

LABEL org.opencontainers.image.title="Mesh local lk-jwt-service security prototype"
LABEL org.opencontainers.image.version="v0.5.0-mesh-prototype"
LABEL org.opencontainers.image.source="https://github.com/element-hq/lk-jwt-service"
LABEL org.opencontainers.image.revision="199ac87dbbf704320b277aebdf10a6280b18c77d"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.mesh.prototype.mode="local-only"

EXPOSE 8080
WORKDIR /
USER 65532:65532
CMD ["/lk-jwt-service"]
