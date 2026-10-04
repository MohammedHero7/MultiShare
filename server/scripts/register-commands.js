// Registers the /watch slash command. Run once: `npm run register` from the project root.
// Uses the client-credentials grant, so no bot token is needed.

import { config } from '../src/config.js';
import { DISCORD_API } from '../src/discord.js';

if (!config.clientId || !config.clientSecret) {
  console.error('Set VITE_DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
  },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'applications.commands.update' }),
});
const token = await tokenResponse.json();
if (!tokenResponse.ok) {
  console.error('Could not get an app token:', token);
  process.exit(1);
}

const command = {
  name: 'watch',
  description: 'Open the watch party in this voice channel with a video link',
  type: 1,
  contexts: [0],
  integration_types: [0],
  options: [
    {
      type: 3,
      name: 'url',
      description: 'YouTube link or direct link to a video (.mp4, .webm or .m3u8)',
      required: true,
    },
  ],
};

// POST creates or updates this one command without touching the activity's
// Entry Point command (a bulk PUT would try to remove it).
const response = await fetch(`${DISCORD_API}/applications/${config.clientId}/commands`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(command),
});
const result = await response.json();
if (!response.ok) {
  console.error('Discord rejected the command:', JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(`Registered /${result.name} (id ${result.id}). It can take a minute to show up in Discord.`);
