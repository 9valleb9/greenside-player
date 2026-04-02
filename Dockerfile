FROM nginx:alpine

# Remove default nginx content
RUN rm -rf /usr/share/nginx/html/*

# Copy player files
COPY index.html /usr/share/nginx/html/
COPY player.css /usr/share/nginx/html/
COPY player.js  /usr/share/nginx/html/

# Custom nginx config for SPA + caching
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
# multi-arch rebuild
