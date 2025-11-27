# Use the official Puppeteer image (Contains Chrome + Node.js)
FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Switch to root user to setup folders
USER root

WORKDIR /app

# Copy dependency files first
COPY package.json ./

# Install dependencies
RUN npm install

# Copy all your app files
COPY . .

# Create the temp folders and give permission to the special 'pptruser'
# (Puppeteer runs as a restricted user for security)
RUN mkdir -p uploads public/temp && \
    chown -R pptruser:pptruser /app

# Switch back to the secure user
USER pptruser

# Open the port
EXPOSE 3000

# Start command
CMD ["node", "server.js"]