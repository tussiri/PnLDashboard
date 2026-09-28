FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig*.json vite.config.ts ./
COPY src ./src
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm build

FROM nginx:1.27-alpine
# The entrypoint renders templates/ into conf.d/ with envsubst (API_UPSTREAM, NGINX_RESOLVER) and
# only substitutes variables that are set, so nginx's own $variables pass through untouched.
ENV API_UPSTREAM=api:8000
COPY docker/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/web/15-resolver.envsh /docker-entrypoint.d/15-resolver.envsh
RUN chmod 755 /docker-entrypoint.d/15-resolver.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
