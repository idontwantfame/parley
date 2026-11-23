// Backport discordjs/discord.js#11581 into @discordjs/voice 0.19.2 until the fix
// ships in a stable release: after a channel move the connection must
// reconfigure networking while still signalling, or it never reaches Ready.
//
// Runs as the npm postinstall (local installs) and explicitly in the Dockerfile.
// Idempotent: an already-patched file is left alone. Other versions or a
// missing package are a no-op. An unexpected source fails an explicit run
// (keeps the Docker build honest) but only warns during `npm install`.
//
// Usage: node scripts/patch-discord-voice.mjs [path/to/@discordjs/voice]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET_VERSION = '0.19.2';
const ORIGINAL = '    if (packet.channel_id) this.joinConfig.channelId = packet.channel_id;';
const PATCHED = ORIGINAL + '\n    if (packet.channel_id && this.state.status === "signalling") this.configureNetworking();';
const ENTRIES = ['dist/index.mjs', 'dist/index.js'];

const voiceDir = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]) + '/')
  : new URL('../node_modules/@discordjs/voice/', import.meta.url);
const strict = process.env.npm_lifecycle_event !== 'postinstall';

function patchVoice() {
  const pkg = new URL('package.json', voiceDir);
  if (!existsSync(pkg)) return 'skipped: @discordjs/voice is not installed';
  const { version } = JSON.parse(readFileSync(pkg, 'utf8'));
  if (version !== TARGET_VERSION) return `skipped: @discordjs/voice ${version} (patch targets ${TARGET_VERSION})`;
  for (const entry of ENTRIES) {
    const file = new URL(entry, voiceDir);
    const contents = readFileSync(file, 'utf8');
    if (contents.includes(PATCHED)) continue;
    if (contents.split(ORIGINAL).length !== 2) throw new Error(`Unexpected voice library source in ${entry}`);
    writeFileSync(file, contents.replace(ORIGINAL, PATCHED));
  }
  return `patched @discordjs/voice ${version}`;
}

try {
  console.log(`[patch-discord-voice] ${patchVoice()}`);
} catch (err) {
  console.warn(`[patch-discord-voice] ${err.message}`);
  if (strict) process.exitCode = 1;
}
