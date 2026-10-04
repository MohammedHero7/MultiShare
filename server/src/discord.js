import { config } from './config.js';
import { UserError } from './errors.js';

export const DISCORD_API = 'https://discord.com/api/v10';

/** Exchange the code from discordSdk.commands.authorize() for an access token. */
export async function exchangeCode(code) {
  if (!config.clientId || !config.clientSecret) {
    throw new UserError('The server is missing VITE_DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET in .env.');
  }
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code: String(code ?? ''),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new UserError(`Discord sign-in failed: ${data.error_description || data.error || `HTTP ${response.status}`}`);
  }
  return data.access_token;
}

const userCache = new Map();

/** Look up who owns an access token. Cached so reconnects don't hit Discord's API. */
export async function getUser(accessToken) {
  const cached = userCache.get(accessToken);
  if (cached && cached.expires > Date.now()) return cached.user;

  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new UserError('Discord did not accept your sign-in. Close and reopen the activity.');
  const data = await response.json();
  const user = { id: data.id, name: data.global_name || data.username, avatar: avatarUrl(data) };

  if (userCache.size > 1000) userCache.clear();
  userCache.set(accessToken, { user, expires: Date.now() + 10 * 60 * 1000 });
  return user;
}

function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  const index =
    user.discriminator && user.discriminator !== '0'
      ? Number(user.discriminator) % 5
      : Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
