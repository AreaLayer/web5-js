FROM node:18-alpine
RUN apk add --no-cache git python3 make g++
ADD . /web5-js
WORKDIR /web5-js
RUN npm ci --ws
RUN npm install --no-save express express-openapi
RUN npm run build
RUN npx tsc -p .web5-spec/tsconfig.json
CMD ["node", ".web5-spec/dist/main.js"]
