# Use the official Puppeteer image (Contains Chrome + Node.js)
FROM ghcr.io/puppeteer/puppeteer:21.5.2

USER root
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p uploads public/temp && \
    chown -R pptruser:pptruser /app && \
    chown -R pptruser:pptruser /home/pptruser/.cache

USER pptruser
EXPOSE 3000

CMD ["node", "server.js"]