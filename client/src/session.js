import { Common, DiscordSDK, Platform } from '@discord/embedded-app-sdk';

const params = new URLSearchParams(location.search);

/** Discord loads activities with ?frame_id=...; without it we're in a normal browser tab. */
export const isInDiscord = params.has('frame_id');

let discordSdk = null;

/**
 * Opens a website outside the activity. Discord blocks popups and new tabs from
 * activities, so inside Discord it asks Discord to open the link (the user confirms).
 */
export async function openExternalLink(url) {
  if (discordSdk) {
    await discordSdk.commands.openExternalLink({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

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
  discordSdk = sdk;

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

  // Phones: let people turn the activity sideways for a bigger picture, and keep the
  // small floating window (after leaving the call screen) in the video's shape.
  if (sdk.platform === Platform.MOBILE) {
    const { UNLOCKED, LANDSCAPE } = Common.OrientationLockStateTypeObject;
    sdk.commands
      .setOrientationLockState({ lock_state: UNLOCKED, picture_in_picture_lock_state: LANDSCAPE, grid_lock_state: LANDSCAPE })
      .catch(() => {
        // older Discord apps: keep their default
      });
  }

  return {
    sdk,
    instanceId: sdk.instanceId,
    channelId: sdk.channelId,
    credentials: { accessToken: data.access_token },
  };
}
