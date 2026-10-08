# Build: Vite production build (minified, no source maps)
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# commit the image is built from (.git is not in the context), shown in the log bar
ARG COMMIT=
ENV VITE_COMMIT=$COMMIT
RUN npm run build

# Serve: static files only
FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
