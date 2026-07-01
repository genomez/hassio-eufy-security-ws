# Local HA apps may ignore build.yaml and pass an old BUILD_FROM (3.20 / Node 20).
# Pin Node 24 base directly so eufy-security-ws 3.0.1 can build.
FROM ghcr.io/home-assistant/amd64-base:3.23

ARG EUFY_SECURITY_WS_VERSION=3.0.1
ARG EUFY_SECURITY_CLIENT_GIT=github:genomez/eufy-security-client#T9000-testing
# Bump when EUFY_SECURITY_CLIENT_GIT changes to invalidate Docker layer cache.
ARG EUFY_CLIENT_BUILD_ID=p2p-nickname

WORKDIR /usr/src/app
COPY eufy-security-ws-mega-login.patch /tmp/

RUN \
    set -x \
    && echo "EUFY_CLIENT_BUILD_ID=$EUFY_CLIENT_BUILD_ID" \
    && apk add --no-cache jq nodejs npm patch git bash \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24, got $(node --version)" >&2; exit 1 ;; esac \
    && if [ -n "$EUFY_SECURITY_CLIENT_GIT" ]; then \
         echo "FORCE: Using Custom Git URL for client: $EUFY_SECURITY_CLIENT_GIT" \
         && npm init -y \
         && npm pkg set name="hassio-eufy-security-ws" \
         && npm pkg set private=true \
         && npm pkg set dependencies.eufy-security-ws="$EUFY_SECURITY_WS_VERSION" \
         && npm pkg set overrides.eufy-security-client="$EUFY_SECURITY_CLIENT_GIT" \
         && npm install --force \
         && if [ -d /usr/src/app/node_modules/eufy-security-client ]; then \
              CLIENT_DIR=/usr/src/app/node_modules/eufy-security-client; \
            elif [ -d /usr/src/app/node_modules/eufy-security-ws/node_modules/eufy-security-client ]; then \
              CLIENT_DIR=/usr/src/app/node_modules/eufy-security-ws/node_modules/eufy-security-client; \
            else \
              echo "eufy-security-client not found after npm install" >&2; exit 1; \
            fi \
         && echo "Building custom client from $EUFY_SECURITY_CLIENT_GIT into $CLIENT_DIR" \
         && REPO="${EUFY_SECURITY_CLIENT_GIT#github:}" \
         && REPO="${REPO%%#*}" \
         && BRANCH="${EUFY_SECURITY_CLIENT_GIT#*#}" \
         && BRANCH="${BRANCH:-main}" \
         && rm -rf /tmp/eufy-security-client \
         && git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" /tmp/eufy-security-client \
         && cd /tmp/eufy-security-client \
         && npm install --include=dev \
         && npm run build \
         && rm -rf "$CLIENT_DIR"/* \
         && cp -a build package.json "$CLIENT_DIR/"; \
       else \
         echo "STANDARD: Using stock version: $EUFY_SECURITY_WS_VERSION" \
         && npm install --force "eufy-security-ws@${EUFY_SECURITY_WS_VERSION}"; \
       fi \
    && WS_DIR=/usr/src/app/node_modules/eufy-security-ws \
    && CLIENT_DIR=/usr/src/app/node_modules/eufy-security-client \
    && if [ ! -d "$CLIENT_DIR" ]; then CLIENT_DIR="$WS_DIR/node_modules/eufy-security-client"; fi \
    && echo "Building patched eufy-security-ws ${EUFY_SECURITY_WS_VERSION} from source" \
    && git clone --depth 1 --branch "$EUFY_SECURITY_WS_VERSION" https://github.com/bropat/eufy-security-ws.git /tmp/eufy-security-ws-src \
    && sed -i 's/\r$//' /tmp/eufy-security-ws-mega-login.patch \
    && cd /tmp/eufy-security-ws-src \
    && patch -p1 < /tmp/eufy-security-ws-mega-login.patch \
    && rm -rf node_modules/eufy-security-client \
    && mkdir -p node_modules \
    && cp -a "$CLIENT_DIR" node_modules/eufy-security-client \
    && npm install --include=dev --force \
    && npm run build \
    && cp -a dist/. "$WS_DIR/dist/" \
    && echo "Patched eufy-security-ws installed to $WS_DIR/dist"

COPY run.sh /
RUN sed -i 's/\r$//' /run.sh && chmod a+x /run.sh
WORKDIR /data

CMD [ "/run.sh" ]
