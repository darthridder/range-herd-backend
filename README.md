# Range Herd Tech — Backend

Fastify + Prisma + PostgreSQL backend for LoRa cattle tracking.  
Receives telemetry from The Things Network (TTN) via MQTT and serves it to the dashboard via REST + WebSocket.

## Prerequisites

- Node.js 18+
- Docker (for PostgreSQL)
- TTN account with a registered application and API key

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your TTN credentials and DB URL

# 3. Start PostgreSQL
docker-compose up db -d

# 4. Run database migrations
npm run db:migrate

# 5. Start development server
npm run dev
```

Server starts at `http://localhost:8080`

## Environment Variables

See `.env.example` for all required variables and descriptions.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `TTN_APP_ID` | ✅ | Your TTN Application ID |
| `TTN_API_KEY` | ✅ | TTN API key with uplink read permission |
| `TTN_REGION` | ✅ | TTN region (`nam1`, `eu1`, etc.) |
| `TTN_TENANT` | ✅ | Usually `ttn` |
| `PORT` | optional | HTTP port (default: 8080) |
| `CORS_ORIGIN` | optional | Frontend origin(s), comma-separated |

## API Reference

### `GET /health`
Returns server status, WebSocket client count, and uptime.

### `GET /devices`
Returns all registered devices ordered by last seen.

### `GET /devices/:deviceId/latest`
Returns the most recent telemetry record for a device.

### `GET /devices/:deviceId/history`
Returns telemetry history for a device.

**Query params:**
- `limit` — max records to return (default: 100, max: 1000)
- `since` — ISO 8601 timestamp to filter from

### `WS /live`
WebSocket feed. Messages:
```json
{ "type": "hello", "ts": "ISO8601" }
{ "type": "uplink", "data": { ...LivePoint } }
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled production build |
| `npm run db:migrate` | Run migrations (dev) |
| `npm run db:migrate:prod` | Run migrations (production) |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run db:generate` | Regenerate Prisma client |

## Architecture

```
LoRa Ear Tag
   ↓
LoRa Gateway
   ↓
The Things Network (MQTT over TLS :8883)
   ↓
server.ts (Fastify)
   ├── POST telemetry → Prisma → PostgreSQL
   └── WebSocket broadcast → React Dashboard
```

## Data Pipeline

1. TTN receives uplink from ear tag via LoRa gateway
2. Backend subscribes to `v3/{app}@{tenant}/devices/+/up` via MQTT over TLS
3. Payload is decoded and normalized (`normalizeUplink`)
4. Device record upserted, telemetry record created in PostgreSQL
5. All connected WebSocket clients receive live broadcast

## Rate Limiting

All endpoints are rate-limited to **100 requests per minute** per IP.

## Known Limitations / Next Up

- [ ] Authentication (Priority 2)
- [ ] Geofencing engine
- [ ] Alert system (low battery, out of bounds, inactivity)
- [ ] Multi-ranch / multi-tenant support
- [ ] Telemetry aggregation / analytics endpoints
- [ ] Production deployment (Railway / Fly.io / EC2)
