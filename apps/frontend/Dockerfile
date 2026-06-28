FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL
ARG VITE_MEDIAMTX_WEBRTC_URL
ARG VITE_MEDIAMTX_HLS_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_MEDIAMTX_WEBRTC_URL=$VITE_MEDIAMTX_WEBRTC_URL
ENV VITE_MEDIAMTX_HLS_URL=$VITE_MEDIAMTX_HLS_URL
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
