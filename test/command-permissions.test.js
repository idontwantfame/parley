// Slash commands that change server settings or campaigns check the member's
// Manage Server permission in the handler too, not only through Discord's
// default_member_permissions (which a server can override per role/channel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { ADMIN_ONLY_REPLY, lacksManageGuild } from '../src/commands/permissions.js';

function interaction(commandName, { sub = null, perms = [] } = {}) {
  return {
    commandName,
    memberPermissions: new PermissionsBitField(perms),
    options: { getSubcommand: () => sub },
  };
}

test('/setup and campaign-changing /campaign subcommands need Manage Server', () => {
  for (const [name, sub] of [['setup', null], ['campaign', 'create'], ['campaign', 'link']]) {
    assert.equal(lacksManageGuild(interaction(name, { sub })), true, `${name} ${sub}`);
    assert.equal(lacksManageGuild(interaction(name, { sub, perms: [PermissionFlagsBits.ManageGuild] })), false, `${name} ${sub}`);
  }
});

test('read-only and everyday commands stay open to every member', () => {
  for (const [name, sub] of [['campaign', 'list'], ['ask', null], ['summary', null], ['join', null]]) {
    assert.equal(lacksManageGuild(interaction(name, { sub })), false, `${name} ${sub}`);
  }
});

test('a member with no permission data is refused an admin command', () => {
  assert.equal(lacksManageGuild({ commandName: 'setup', memberPermissions: null, options: { getSubcommand: () => null } }), true);
  assert.match(ADMIN_ONLY_REPLY, /Manage Server/);
});
