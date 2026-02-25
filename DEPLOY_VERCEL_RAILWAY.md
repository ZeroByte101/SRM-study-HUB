# Deploy Frontend on Vercel + Backend on Railway

## 1) Backend (Railway)

1. Push this project to GitHub.
2. In Railway, create a project from this repo.
3. Add a persistent Volume and mount it at `/data`.
4. Set environment variables:
   - `HOST=0.0.0.0`
   - `SQLITE_PATH=/data/db.sqlite`
   - `YOUTUBE_API_KEY=...` (optional, for video search)
   - `GEMINI_API_KEY=...` (optional, for richer AI analysis)
5. Deploy and copy your backend URL, for example:
   - `https://your-backend.up.railway.app`

## 2) Frontend (Vercel)

1. Import the same repo in Vercel.
2. Deploy.
3. Open your frontend URL once using:

`https://your-frontend.vercel.app/?apiBase=https://your-backend.up.railway.app`

This saves backend URL in browser local storage (`srm-api-base`) for future visits.

## 3) Notes

- You can also hardcode backend URL in `index.html`:
  - `window.SRM_API_BASE = "https://your-backend.up.railway.app";`
- If you change backend URL later, open frontend again with `?apiBase=...`.
- Socket.IO chat is configured to use the same backend base URL.
