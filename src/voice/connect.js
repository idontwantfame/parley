// Establish a Ready voice connection for a channel, with the handshake
// diagnostics that make "stuck in signalling/connecting" reports debuggable.
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';

export const JOIN_READY_TIMEOUT_MS = 25_000;

/** The first voice permission the bot lacks in `channel` ('Connect'/'Speak'), or null. */
export function missingVoicePermission(channel) {
  const perms = channel.guild.members.me?.permissionsIn(channel);
  if (!perms?.has('Connect')) return 'Connect';
  if (!perms?.has('Speak')) return 'Speak';
  return null;
}

// Wrap the guild's adapter to count gateway voice packets for diagnostics.
function countingAdapter(createAdapter, handshake) {
  return (callbacks) => {
    const adapter = createAdapter({
      ...callbacks,
      onVoiceServerUpdate(packet) {
        handshake.serverUpdates++;
        handshake.hasEndpoint = Boolean(packet.endpoint);
        callbacks.onVoiceServerUpdate(packet);
      },
      onVoiceStateUpdate(packet) {
        handshake.stateUpdates++;
        callbacks.onVoiceStateUpdate(packet);
      },
    });
    return {
      ...adapter,
      sendPayload(payload) {
        const sent = adapter.sendPayload(payload);
        if (sent && payload.d.channel_id) handshake.sent++;
        return sent;
      },
    };
  };
}

function observeHandshake(connection, handshake, debugLog) {
  const observedNetworking = new WeakSet();
  connection.on('stateChange', (oldState, newState) => {
    debugLog(`[voice] stateChange: ${oldState.status} -> ${newState.status}`);
    if (newState.status !== oldState.status) handshake.transitions.push(newState.status);
    if (newState.networking && !observedNetworking.has(newState.networking)) {
      observedNetworking.add(newState.networking);
      newState.networking.once('close', (code) => handshake.closeCodes.push(code));
    }
  });
  connection.on('error', (err) => console.error('[voice] connection error:', err.message));
}

/**
 * Join `channel` and resolve its connection once Ready. On failure the
 * connection is destroyed (never left half-open) and an Error is thrown.
 */
export async function connectToChannel(channel, { botUser, debugLog = () => {} }) {
  const missing = missingVoicePermission(channel);
  if (missing) {
    throw new Error(`Bot lacks **${missing}** permission in this voice channel. Check server roles / channel overrides.`);
  }
  debugLog(`[voice] joinVoiceChannel guild=${channel.guild.id} channel=${channel.id}`);
  const handshake = { sent: 0, stateUpdates: 0, serverUpdates: 0, hasEndpoint: false, transitions: [], closeCodes: [] };
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: channel.guild.id,
    adapterCreator: countingAdapter(channel.guild.voiceAdapterCreator, handshake),
    selfDeaf: false, selfMute: true,
  });
  debugLog(`[voice] connection initial state: ${connection.state.status}`);
  observeHandshake(connection, handshake, debugLog);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, JOIN_READY_TIMEOUT_MS);
    debugLog('[voice] connection reached Ready');
    return connection;
  } catch (err) {
    const status = connection.state.status;
    console.error(`[voice] entersState failed after ${JOIN_READY_TIMEOUT_MS / 1000}s. Final state: ${status}`);
    console.error('[voice] handshake:', JSON.stringify({
      ...handshake, channelLimit: channel.userLimit, channelFull: channel.full,
      canMoveMembers: channel.permissionsFor(botUser)?.has('MoveMembers') ?? false,
    }));
    if (status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    throw new Error(`Voice connection failed while ${status}: ${err.message}`);
  }
}
