# Render Analytics Service (with pixel fallback)

Deploy as Render **Web Service**.

## Render settings
- Build: `npm install`
- Start: `npm start`

## Persistence (recommended)
Add Persistent Disk mount `/var/data` and set env var:
- DB_PATH=/var/data/data.sqlite

## CORS
Set env var ALLOWED_ORIGINS to the banner/game origins, e.g.:
- https://pulsmediacdn.com,https://pulsmedia.is

If unset, allows all origins.

## Pixel fallback
If fetch() is blocked by CSP/CORS, you can send events via an image request:
- /api/pixel.gif?event=banner_view&campaign_id=...&game_id=...

This is implemented in the updated banner package I provided.
