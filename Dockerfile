FROM node:18
WORKDIR /app
COPY package*.json .
RUN yarn install
RUN yarn global add ts-node
COPY . .
RUN yarn build
CMD ["node", "dist/index.js"]
