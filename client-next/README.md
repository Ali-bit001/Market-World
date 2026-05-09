# Market World Next.js Migration

This folder now contains a unified Next.js project that serves both:

- Frontend (App Router)
- Backend API + WebSocket (through a custom Express server)

## Architecture

- Next app routes: `src/app/**`
- Reusable UI views: `src/views/**`
- Auth/context/hooks/api client: `src/context`, `src/hooks`, `src/api`
- Custom server entry: `server.js`
- Existing backend logic is reused from `../server/src/**`

The custom server mounts all existing API routes under `/api` and initializes WebSocket + simulation services on the same host/port as Next.

## Requirements

- Node.js 18+
- MongoDB Atlas configured via `../server/.env` (`MONGODB_URI` and `MONGODB_DB_NAME`)
- Environment file at `../server/.env`

Recommended after pulling latest changes:

```bash
node ../server/database/init_mongo.js
```

The runtime now uses a MongoDB-backed SQL compatibility adapter for existing backend queries.

## Run

```bash
npm install
npm run dev
```

App and API run from the same process on `http://localhost:5000` by default.

## Build

```bash
npm run build
npm start
```

## API and Socket

- HTTP API base URL in frontend is `/api`
- WebSocket URL is automatically derived from browser host (`ws://` or `wss://`)

## Notes

- Legacy prototype routes `/market` and `/dashboard/companies` currently redirect to `/dashboard`.
- Legacy Vite frontend folder `../client` has been removed after migration.
- The backend source remains in `../server/src` and is mounted by `server.js`.
- Asset identity is now unified through `assets.id` (shares, commodities, bonds, crypto all reference a shared parent table).
