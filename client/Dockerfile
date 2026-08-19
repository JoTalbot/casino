FROM node:20-alpine AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci
COPY client/ ./client/
COPY config/ ./config/
COPY tests/fixtures/ ./tests/fixtures/
RUN npm --prefix client run build

FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
