# CampusHub Deployment Guide

This project is ready to run locally and can be deployed as a single Node.js service.

## 1) Configure environment variables

Create `.env` from `.env.example` and fill values:

- `PORT`: server port (usually set by hosting provider)
- `MONGODB_URI`: you will configure this
- `DB_NAME`: you will configure this
- `CORS_ORIGIN`: your frontend domain (leave empty if same domain)
- `SESSION_TTL_MS`: session expiry in milliseconds
- `MAX_JSON_BODY`: max JSON request body size
- `OPEN_SESSION_RATE_LIMIT`: max repository open attempts per IP per window
- `OPEN_SESSION_WINDOW_MS`: rate-limit window duration

## 2) Install dependencies

```bash
npm install
```

## 3) Start locally

```bash
npm start
```

Open `http://localhost:3000`.

## 4) Production checks before go-live

- Ensure `.env` is set in deployment platform
- Ensure persistent filesystem or replace uploads with cloud storage
- Keep HTTPS enabled on deployment platform
- Verify `CORS_ORIGIN` if frontend and backend are on different domains

## 5) Health check endpoint

Use:

```text
GET /api/health
```

It returns server uptime, active sessions, and repository count.
