# ---- build stage ----
FROM node:24-alpine AS build

WORKDIR /app

# Manifests first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM nginx:alpine

# The official image runs envsubst over /etc/nginx/templates/*.template on start, which is how
# BACKEND_URL reaches the config without rebuilding the image.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

ENV BACKEND_URL=http://backend:8080
EXPOSE 80
