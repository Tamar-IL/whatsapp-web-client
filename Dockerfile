# שלב 1: בניית האפליקציה (קומפילציה מ-TS ל-JS)
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# שלב 2: הרצת האפליקציה בלבד (כדי שהאימג' יהיה קל ומהיר)
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/index.js"]
