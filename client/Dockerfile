# The client: build the static bundle with Node, serve it with nginx. Ported
# from Project 2. The final image holds the built files and nginx -- no Node, no
# source, no node_modules. Build context: client/.

# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Vite and its plugins are dev dependencies, and the build needs them. This
# stage is thrown away, so they never reach the final image.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine AS serve

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
