# Discord Watch Party

A Discord Activity: paste a video link and everyone in the voice channel watches it in sync.
Play, pause and seek are shared. Optional shared subtitles (Arabic supported), a movie library
from a folder on your PC, and a `/watch <url>` command.

Works with YouTube links (needs yt-dlp, see Optional) and direct links (.mp4, .webm, .m3u8).
It does not work with Netflix or other DRM-protected sites. Only stream content you have the
right to share.

## 1. Create the Discord app
1. https://discord.com/developers/applications -> New Application.
2. Activities -> Settings: turn on Enable Activities.
3. OAuth2: copy the Client ID and Client Secret. Add a redirect URI `https://127.0.0.1`.
4. In Discord: User Settings -> Advanced -> turn on Developer Mode (needed to test your own activity).

## 2. Configure
    npm install
    cp .env.example .env     # fill in VITE_DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET

## 3. Run it (development)
    npm run dev              # server on :3001, client on :5173
    npm run tunnel           # needs cloudflared; prints https://something.trycloudflare.com

In the Developer Portal -> Activities -> URL Mappings, map `/` to the tunnel host (without https://).
Join a voice channel, open the Activities menu and launch your app.

## 4. Run it (always-on)
    npm run build
    npm start                # serves the activity and the API on :3001

Point a tunnel or your domain at port 3001 and set the `/` URL mapping to it.

## Optional
- YouTube: install yt-dlp on the computer running the server: `winget install yt-dlp.yt-dlp`,
  then open a new terminal and run `npm run dev` again. The server prints `YouTube links: on`
  when it finds it. yt-dlp needs a JavaScript runtime to get past YouTube's checks: Node.js 22 or
  newer, or Deno (`winget install DenoLand.Deno`).
  If you run npm in VS Code's terminal, restart VS Code after installing. YouTube changes often,
  so if links stop working, update it: `winget upgrade yt-dlp.yt-dlp` (or `yt-dlp -U`).
  YOUTUBE_MAX_HEIGHT (default 1080) caps the quality; lower it to 720 if your upload is slow.
  Set YTDLP_PATH if yt-dlp isn't on your PATH.
- Library: set MEDIA_DIR in .env. A Library tab lists videos and subtitles from that folder.
  Subtitle files named like the movie (Movie.srt, Movie.ar.srt) load automatically.
- /watch command: set DISCORD_PUBLIC_KEY, set the Interactions Endpoint URL to
  https://<your host>/api/interactions, then run `npm run register`. It accepts YouTube links too.
- Test without Discord: ALLOW_GUESTS=true, then open http://localhost:5173/?room=test in two tabs.
  Keep it off when deployed.
- Private links: ALLOW_PRIVATE_URLS=true allows links to servers on your own network (Jellyfin, NAS).

## Notes
- Videos stream through your server, since Discord only lets activities reach their own backend.
  Your upload speed limits how many people can watch at once. This includes YouTube videos.
- Browsers play H.264/AAC MP4 and VP9/WebM. MKV with other codecs may not play.
- Not yet tested inside Discord itself.
