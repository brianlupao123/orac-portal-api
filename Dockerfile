FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Never fall back to development mode (which allows password-less sign-in) if
# the platform forgets to set NODE_ENV. Production still validates STORE_DRIVER and JWT_SECRET.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
