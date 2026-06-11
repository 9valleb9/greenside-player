FROM nginx:alpine

# Build-time arg — CI passes the git SHA so the cache-bust query string
# in index.html (?v=__VERSION__) becomes unique per image. Local builds
# fall back to "dev" which still cache-busts vs. any earlier "dev" only
# if you bump it manually; for CI builds it's deterministic.
ARG BUILD_VERSION=dev

# Remove default nginx content
RUN rm -rf /usr/share/nginx/html/*

# Copy player files
COPY index.html    /usr/share/nginx/html/
COPY player.css    /usr/share/nginx/html/
COPY player.js     /usr/share/nginx/html/
COPY hls-config.js /usr/share/nginx/html/
COPY assets/       /usr/share/nginx/html/assets/

# Rewrite the ?v=__VERSION__ placeholders in index.html so each build
# serves a unique CSS/JS URL — bypasses Chromium's disk cache without
# requiring a manual cache clear on the kiosk after every visual change.
RUN sed -i "s/__VERSION__/${BUILD_VERSION}/g" /usr/share/nginx/html/index.html

# Custom nginx config for SPA + caching
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
# multi-arch rebuild
