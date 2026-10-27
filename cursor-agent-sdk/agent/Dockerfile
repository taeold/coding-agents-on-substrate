FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot ./bot

EXPOSE 80

CMD ["/app/node_modules/.bin/agent-sdk", "serve", "--dir", "/app", "--mode", "single", \
     "--host", "0.0.0.0", "--port", "80", "--state-root", "/workspace/state", \
     "--allow-anonymous", "--no-playground", "--no-docs"]
