// Optional /watch slash command. Discord POSTs interactions here; we verify the
// signature, queue the link, and answer with LAUNCH_ACTIVITY so the activity opens.
//
// Setup: put DISCORD_PUBLIC_KEY in .env, set the Interactions Endpoint URL in the
// Developer Portal to https://<your server>/api/interactions, then `npm run register`.

import crypto from 'node:crypto';
import { config } from './config.js';
import { parseUserUrl } from './safe-http.js';
import { queueWatch } from './rooms.js';

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, LAUNCH_ACTIVITY: 12 };
const EPHEMERAL = 1 << 6;

let publicKey = null;
function getPublicKey() {
  if (!config.publicKey) return null;
  if (!publicKey) {
    const raw = Buffer.from(config.publicKey, 'hex');
    publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  }
  return publicKey;
}

function isValidSignature(req) {
  const key = getPublicKey();
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  if (!key || !signature || !timestamp || !Buffer.isBuffer(req.body)) return false;
  try {
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), req.body]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const reply = (res, content) => res.json({ type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });

/** POST /api/interactions — must receive the raw body (express.raw). */
export function handleInteraction(req, res) {
  if (!config.publicKey) {
    res.status(404).send('Slash commands are not configured. Set DISCORD_PUBLIC_KEY in .env.');
    return;
  }
  if (!isValidSignature(req)) {
    res.status(401).send('Invalid request signature.');
    return;
  }

  const interaction = JSON.parse(req.body.toString('utf8'));
  if (interaction.type === InteractionType.PING) {
    res.json({ type: ResponseType.PONG });
    return;
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'watch') {
    const url = interaction.data.options?.find((option) => option.name === 'url')?.value;
    const user = interaction.member?.user ?? interaction.user;
    const channelId = interaction.channel?.id ?? interaction.channel_id;
    try {
      parseUserUrl(url);
    } catch (error) {
      reply(res, error.message);
      return;
    }
    queueWatch({
      url,
      userId: user?.id,
      userName: user?.global_name || user?.username || 'Someone',
      channelId,
    });
    res.json({ type: ResponseType.LAUNCH_ACTIVITY });
    return;
  }

  reply(res, 'Unknown command.');
}
