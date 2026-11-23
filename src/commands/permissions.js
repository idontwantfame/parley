// src/commands/permissions.js
// Slash commands that change server settings or campaigns. Discord hides them
// from members without Manage Server (default_member_permissions), but a
// server can override that per role or channel, so the handler checks too.
import { PermissionFlagsBits } from 'discord.js';

export const ADMIN_ONLY_REPLY = '❌ You need the Manage Server permission to do that.';

const ADMIN_COMMANDS = new Set(['setup']);
// Commands where only some subcommands change anything (/campaign list is read-only).
const ADMIN_SUBCOMMANDS = new Map([['campaign', new Set(['create', 'link'])]]);

function isAdminCommand(interaction) {
  if (ADMIN_COMMANDS.has(interaction.commandName)) return true;
  const subs = ADMIN_SUBCOMMANDS.get(interaction.commandName);
  return !!subs && subs.has(interaction.options.getSubcommand(false));
}

/** True when this chat command needs Manage Server and the member lacks it. */
export function lacksManageGuild(interaction) {
  if (!isAdminCommand(interaction)) return false;
  return !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}
