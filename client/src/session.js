import { DiscordSDK } from '@discord/embedded-app-sdk';

const params = new URLSearchParams(location.search);

/** Discord loads activities with ?frame_id=...; without it we're in a normal browser tab. */
export const isInDiscord = params.has('frame_id');

/**
 * Resolves to { instanceId, channelId, credentials } for the sync connection.
 * Inside Discord this runs the OAuth handshake; in a browser tab it uses guest mode
 * (only allowed when the server has ALLOW_GUESTS=true).
 */
export async function startSession() {
  if (!isInDiscord) {
    const room = (params.get('room') || 'test').slice(0, 64);
    const name = params.get('name') || `Guest ${Math.floor(100 + Math.random() * 900)}`;
    return { instanceId: `guest:${room}`, channelId: null, credentials: { guest: name } };
  }

  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is missing from .env. Add it and rebuild the client.');

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const response = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error || `Sign-in failed (HTTP ${response.status}).`);

  const auth = await sdk.commands.authenticate({ access_token: data.access_token });
  if (!auth) throw new Error('Discord did not accept the sign-in.');

  return {
    sdk,
    instanceId: sdk.instanceId,
    channelId: sdk.channelId,
    credentials: { accessToken: data.access_token },
  };
}
