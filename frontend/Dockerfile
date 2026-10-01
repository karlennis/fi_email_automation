# Frontend image: builds the Angular app and serves it from nginx, which also proxies
# /api/ to the backend container. Build context is the repository root (see
# docker-compose.yml) so the nginx config in docker/ is reachable.

FROM node:20-bookworm-slim AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
# Full install: the Angular CLI and build tooling are devDependencies.
RUN npm ci
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 80
