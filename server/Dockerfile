FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/posts.sqlite
WORKDIR /app
COPY server.mjs analytics-data.mjs ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
