FROM nginx:alpine

# Custom nginx config: serves static files + proxies /api/* to the backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static frontend files (HTML, CSS, JS)
COPY src/ /usr/share/nginx/html/

EXPOSE 80
