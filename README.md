# SRM Student Hub

A local Express and Socket.IO app for SRM Ramapuram student workflows.

## Features

- Real-time chat using Socket.IO
- Attendance tracking with LowDB (`db.json`)
- Campus events feed from local data
- Topic-based study video search through `/videos/:topic`
- Dynamic site content API (`GET /site-data`) with frontend fallback defaults

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Optional: add a YouTube API key for live video search responses:
   ```bash
   set YOUTUBE_API_KEY=YOUR_KEY_HERE   # PowerShell
   # or
   export YOUTUBE_API_KEY=YOUR_KEY_HERE # macOS/Linux
   ```
3. Run the server:
   ```bash
   npm start
   ```
4. Open <http://localhost:3000>

## Notes

- Backend API and socket contracts remain unchanged.
- Core website content is served from `siteContent` in SQLite (seeded from `site-content.json` on first run).
- You can update content dynamically using `PUT /site-data` with `x-admin-key` header matching `SITE_ADMIN_KEY`.
- Data in `db.json` is local/demo storage.

## Source Pages Used for Institutional Snapshot

- https://www.srmrmp.edu.in/
- https://www.srmrmp.edu.in/engineering/
- https://www.srmrmp.edu.in/admissions-and-aid/
- https://www.srmrmp.edu.in/placements/
- https://www.srmrmp.edu.in/department-of-computer-science-and-engineering-cse/
