FROM node:24-slim

WORKDIR /app

# Install dependencies first so this layer is cached across source edits.
# Full install (not --omit=dev): tsx (backend runtime) and vite (frontend build)
# both live in devDependencies.
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the app. The backend runs unbuilt via tsx.
COPY . .

# The only build step: bundle the React inspector into web/dist.
RUN npm run build

EXPOSE 8787

# Express serves both the built inspector and the backend on a single port.
CMD ["npm", "run", "start"]