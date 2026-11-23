import { entersState as voiceEntersState, VoiceConnectionStatus } from '@discordjs/voice';

// How long a Disconnected connection gets to START reconnecting (Signalling /
// Connecting) — per @discordjs/voice guidance this tells a region move or blip
// from a kick — and then how long it gets to actually reach Ready again.
export const RECONNECT_START_MS = 5_000;
export const RECONNECT_READY_MS = 20_000;

/**
 * Resolve 'ready' when a Disconnected connection recovers, 'gone' when it never
 * starts reconnecting, or 'stuck' when it starts but doesn't reach Ready in
 * time (otherwise a meeting could sit in 'recording' with no audio forever).
 */
export async function waitForReconnect(connection, {
  entersState = voiceEntersState, startMs = RECONNECT_START_MS, readyMs = RECONNECT_READY_MS,
} = {}) {
  try {
    await Promise.race([
      entersState(connection, VoiceConnectionStatus.Signalling, startMs),
      entersState(connection, VoiceConnectionStatus.Connecting, startMs),
    ]);
  } catch {
    return 'gone';
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, readyMs);
    return 'ready';
  } catch {
    return 'stuck';
  }
}
