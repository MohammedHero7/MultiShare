# Discord Watch Party

A Discord Activity: paste a video link and everyone in the voice channel watches it in sync.
Play, pause and seek are shared. Optional shared subtitles (Arabic supported), a movie library
from a folder on your PC, and a `/watch <url>` command.

Pick a video from three sources in the Change video panel: Link, Library and YouTube. The
YouTube tab searches YouTube and shows the results as a video grid. Paste a playlist or channel
link there to list its videos, and see what the room has played before.

The Anime tab opens websites in a browser inside the activity: the anime sites, a web search
(DuckDuckGo), or any address you type. Only you see what you browse; load a video for everyone
from the Link tab as usual.

Works with YouTube links (needs yt-dlp, see Optional) and direct links (.mp4, .webm, .m3u8).
It does not work with Netflix or other DRM-protected sites. Only stream content you have the
right to share.

## 1. Create the Discord app
1. https://discord.com/developers/applications -> New Application.
2. Activities -> Settings: turn on Enable Activities. Under Supported Platforms, tick iOS and
   Android as well as Web, or Discord's phone apps won't list the activity.
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

### On phones (iOS and Android)
With iOS and Android ticked under Supported Platforms (step 1), open it from a voice channel in
the Discord app: the rocket button -> your activity. Held upright, the video sits on top with the
controls underneath; turn the phone sideways for a bigger picture (the activity unlocks rotation
itself). When you leave the call screen it keeps playing in Discord's small floating window.
The volume slider is hidden on iPhones and iPads, where only the volume buttons change it.

### Or host it on Render
The repository includes a `Dockerfile` (the app plus yt-dlp) and a `render.yaml` Blueprint.
1. Put the project in a GitHub repository (`.env` stays out of it; it's in `.gitignore`).
2. Render dashboard -> New -> Blueprint -> pick the repository. Enter your Client ID and Client
   Secret when asked. The rest is preset: AdGuard DNS, YouTube capped at 720p, and a
   generated MEDIA_SIGNING_SECRET.
3. When it's live, in the Discord Developer Portal -> Activities -> URL Mappings, map `/` to the
   service's host, e.g. `discord-watch-party.onrender.com` (without https://).

If you made a plain Node web service instead (New -> Web Service, Language: Node), set these in
its Settings. Render runs Linux, so `winget` doesn't exist there; the build script downloads the
Linux yt-dlp instead, and each deploy fetches the newest one. It must be a Web Service, not a
Static Site: the activity needs its server running (sign-in, sync, video), and a Static Site
fails with "Publish directory ... does not exist".
- Build Command: `npm run render-build`
- Start Command: `npm start`
- Environment: `VITE_DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and optionally the other values
  from `render.yaml` (`MEDIA_SIGNING_SECRET`, `DNS_SERVERS`, `YOUTUBE_MAX_HEIGHT`). The Client ID
  must be set before the build, since it's built into the activity.

Know the limits of Render's free plan: every viewer's video goes out through the server, and
5 GB a month is included, after which Render charges per GB or suspends the service. It
sleeps after 15 minutes without traffic and takes about a minute to wake, so open the activity
once, wait, then open it again. YouTube may refuse Render's servers ("confirm you're not a
bot"), and the Library tab doesn't work there because your movie folder isn't on Render.
yt-dlp updates itself each time the server starts.

## Optional
- YouTube: install yt-dlp on the computer running the server: `winget install yt-dlp.yt-dlp`,
  then open a new terminal and run `npm run dev` again. The server prints `YouTube links: on`
  when it finds it. yt-dlp needs a JavaScript runtime to get past YouTube's checks: Node.js 22 or
  newer, or Deno (`winget install DenoLand.Deno`).
  If you run npm in VS Code's terminal, restart VS Code after installing. YouTube changes often,
  so if links stop working, update it: `winget upgrade yt-dlp.yt-dlp` (or `yt-dlp -U`).
  YOUTUBE_MAX_HEIGHT (default 1080) caps the quality; lower it to 720 if your upload is slow.
  Set YTDLP_PATH if yt-dlp isn't on your PATH. The YouTube tab uses yt-dlp too: each search
  takes a few seconds, and results are cached for 10 minutes.
- Library: set MEDIA_DIR in .env. A Library tab lists videos and subtitles from that folder.
  Subtitle files named like the movie (Movie.srt, Movie.ar.srt) load automatically.
- /watch command: set DISCORD_PUBLIC_KEY, set the Interactions Endpoint URL to
  https://<your host>/api/interactions, then run `npm run register`. It accepts YouTube links too.
- Test without Discord: ALLOW_GUESTS=true, then open http://localhost:5173/?room=test in two tabs.
  Keep it off when deployed.
- Private links: ALLOW_PRIVATE_URLS=true allows links to servers on your own network (Jellyfin, NAS).
- DNS filtering: DNS_SERVERS=94.140.14.14,94.140.15.15 makes the server look up every site it
  fetches through AdGuard DNS, so ad, tracker and malware domains are refused. yt-dlp still uses
  the computer's own DNS. This covers the in-activity browser too, so most ads don't load there.

## The in-activity browser
Discord only lets an activity load pages from its own server, so websites opened in the Anime
tab are fetched by your server and passed through, with their links pointed back at it. Pages
run sandboxed: a website can't reach the activity or act in the watch party. Popups are blocked,
and links that would open a new tab open in place. The button next to the address opens the page
outside Discord instead.

What to expect:
- Every page goes through your server, so it counts against your upload speed and, on Render,
  the 5 GB a month.
- Sites behind a "checking your browser" page (Cloudflare and similar) usually don't open, and
  sites that build everything with JavaScript may not work properly. Use "Open outside Discord"
  for those.
- Search uses DuckDuckGo, since Google's results need scripts that don't work this way.
- Cookies (logins, settings) are kept on the server for the session and reset when the activity
  reconnects.
- Google reCAPTCHA ("I'm not a robot") gets the real site's address, and its box and the page
  can talk to each other as they would in a normal browser. Google may still show more picture
  puzzles than usual, since its requests come from your server.

## Notes
- Videos stream through your server, since Discord only lets activities reach their own backend.
  Your upload speed limits how many people can watch at once. This includes YouTube videos.
- Browsers play H.264/AAC MP4 and VP9/WebM. MKV with other codecs may not play.
- Not yet tested inside Discord itself.
