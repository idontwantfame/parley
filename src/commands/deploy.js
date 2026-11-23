import { REST, Routes } from 'discord.js';
import { commandsJSON } from './definitions.js';
import { config } from '../config/env.js';

// One REST client per token. Every REST instance starts sweeper intervals that
// are only cleared explicitly, so a new client per call (per guild on every
// start, plus one per guildCreate) was never garbage-collected.
let cached = null; // { token, rest }

export function restFor(token) {
  if (cached?.token === token) return cached.rest;
  if (cached) {
    cached.rest.clearHashSweeper();
    cached.rest.clearHandlerSweeper();
  }
  cached = { token, rest: new REST({ version: '10' }).setToken(token) };
  return cached.rest;
}

// Register to a specific guild (instant) when guildId is given, else globally
// (slow propagation, ~1h, with flaky cached visibility). We register per-guild
// so command changes like /post appear immediately.
export async function deployCommands(clientId = config.discordClientId, token = config.discordToken, guildId = null) {
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await restFor(token).put(route, { body: commandsJSON() });
}

// Clear the global command set. Used once on boot so commands left over from the
// old global registration don't shadow/duplicate the per-guild ones.
export async function clearGlobalCommands(clientId = config.discordClientId, token = config.discordToken) {
  await restFor(token).put(Routes.applicationCommands(clientId), { body: [] });
}
