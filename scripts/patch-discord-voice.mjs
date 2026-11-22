import { readFileSync, writeFileSync } from 'node:fs';

const voiceDir = new URL('../node_modules/@discordjs/voice/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', voiceDir), 'utf8'));
if (version === '0.19.2') {
  // Backport discordjs/discord.js#11581 until the fix is available in a stable release.
  const original = '    if (packet.channel_id) this.joinConfig.channelId = packet.channel_id;';
  const patched = original + '\n    if (packet.channel_id && this.state.status === "signalling") this.configureNetworking();';

  for (const entry of ['dist/index.mjs', 'dist/index.js']) {
    const file = new URL(entry, voiceDir);
    const contents = readFileSync(file, 'utf8');
    if (contents.split(original).length !== 2) {
      throw new Error('Unexpected voice library source in ' + entry);
    }
    if (!contents.includes(patched)) {
      writeFileSync(file, contents.replace(original, patched));
    }
  }
}
