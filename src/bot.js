// src/bot.js
// All Discord bot wiring. Exported as startBot() so it can be launched lazily —
// the web UI boots first (even with no credentials) and starts the bot once the
// user connects their Discord app. Returns the live client + meeting manager.
//
// One meeting per guild: Discord lets a bot sit in a single voice channel per
// guild and @discordjs/voice keeps one connection per guild, so joins, stops and
// connection teardown are all scoped to the guild's one recording.
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { rm } from 'node:fs/promises';
import { config, validateEnv } from './config/env.js';
import { getGuildConfig, setGuildConfig } from './store/config.js';
import { deployCommands, clearGlobalCommands } from './commands/deploy.js';
import { MeetingManager } from './voice/meeting-manager.js';
import { TrackRegistry, attachCapture } from './voice/capture.js';
import { connectToChannel } from './voice/connect.js';
import { waitForReconnect } from './voice/reconnect.js';
import { GuildVoiceGate, AUTO_LEAVE_GRACE_MS } from './voice/guild-voice-gate.js';
import { canDiscardAudio } from './voice/recording-archive.js';
import { processMeeting } from './pipeline/orchestrator.js';
import { getSummarizer } from './adapters/summarizer/index.js';
import { resolveSummaryLanguage } from './adapters/summarizer/languages.js';
import { shouldAutoJoin, shouldAutoLeave, botMovedAway } from './voice/decisions.js';
import { validateSetup, formatConfigReply } from './commands/setup-logic.js';
import { handleAutocomplete } from './commands/autocomplete.js';
import { resolveGuildMeeting, renderStatus, renderHistory } from './commands/meeting-lookup.js';
import { joinRefusal, joinOutcomeReply } from './commands/voice-replies.js';
import { renderNotesChunks, chunk } from './delivery/discord-notes.js';
import { postNotes, notesThreadName } from './delivery/post.js';
import { askCampaign, recapCampaign, resolveCampaign } from './campaign/ask.js';

// Minimal, non-privileged intents (MessageContent would fail login). Mentions
// are off by default for EVERY message: notes, LLM answers, transcripts and
// error text are posted verbatim and must never ping @everyone/@here or roles.
export const CLIENT_OPTIONS = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [] },
};

export function startBot({ db, audioRoot }) {
  validateEnv({
    DISCORD_TOKEN: config.discordToken,
    DISCORD_CLIENT_ID: config.discordClientId,
  });

  // Verbose voice-lifecycle logging (gateway raw packets, [vSU]/[voice]/[join]
  // traces) is noisy in production; gate it behind DEBUG_VOICE=1. Errors,
  // warnings, and the meaningful lifecycle lines (Started/Stopping, Logged in)
  // stay on unconditionally.
  const DEBUG_VOICE = process.env.DEBUG_VOICE === '1';
  const debugLog = (...args) => { if (DEBUG_VOICE) console.log(...args); };

  const client = new Client(CLIENT_OPTIONS);
  // Always have an 'error' listener: an EventEmitter 'error' without one throws.
  client.on('error', (err) => console.error('[discord] client error:', err.message));
  client.on('raw', (packet) => {
    if (!DEBUG_VOICE) return;
    if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
      console.log(`[gateway] ${packet.t}:`, JSON.stringify(packet.d).substring(0, 200));
    }
  });

  const manager = new MeetingManager({
    db, audioRoot,
    startCapture: ({ meetingId, connection, guild, audioDir }) => {
      const registry = new TrackRegistry();
      const { stopAll } = attachCapture({
        connection, guild, audioDir, registry, meetingId,
        // Record latecomers the moment they first speak (INSERT OR IGNORE keeps
        // it idempotent), so attendees isn't limited to the start snapshot.
        onSpeaker: (userId, displayName) => db.addAttendee(meetingId, userId, displayName),
      });
      return { registry, stopAll };
    },
    finalize: (meetingId, tracks, session) => finalizeMeeting(meetingId, tracks, session),
  });
  const gate = new GuildVoiceGate();
  const finalizingLostConnections = new Set(); // "guildId:channelId" — guards against stopping a lost session twice
  let accepting = true; // false once the controller starts shutting the bot down

  async function sendNotice(channelId, content) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.send(content).catch(() => {});
  }

  async function finalizeMeeting(meetingId, tracks, session) {
    const meeting = db.getMeeting(meetingId);
    const cfg = getGuildConfig(db, meeting.guild_id);
    try {
      const result = await processMeeting(db, meetingId, {
        tracks,
        cfg,
        summarizer: getSummarizer(cfg),
        deliver: async (notes, talktime) => postNotes({ client, meeting, cfg, notes, talktime }),
      });
      // Keep the PCM whenever a retry could still need it (partial transcript).
      if (canDiscardAudio(result, db.getMeeting(meetingId))) {
        await rm(session.audioDir, { recursive: true, force: true }).catch(() => {});
      }
      // Nobody spoke — drop the empty meeting record entirely.
      if (result?.empty) db.deleteMeeting(meetingId);
      // Summary succeeded but posting didn't (perms/deleted channel): the notes
      // are safe in the dashboard and the meeting stays 'done'. Best-effort ping
      // the origin channel so people aren't left waiting on a thread that never comes.
      else if (result?.deliveryError) {
        await sendNotice(meeting.channel_id, `⚠️ Meeting ${meetingId} notes are ready in the dashboard, but I couldn't post them here: ${result.deliveryError}`);
      }
    } catch (err) {
      console.error(`Meeting ${meetingId} failed:`, err.message);
      const reason = err.userMessage || err.message;
      await sendNotice(cfg.notesChannelId || meeting.channel_id, `⚠️ Meeting ${meetingId} failed: ${reason}\nOpen the meeting in Parley to see the available recovery options.`);
    }
  }

  function humanCount(channel) {
    return channel.members.filter((m) => !m.user.bot).size;
  }
  function setRecIndicator(guild, on) {
    guild.members.me?.setNickname(on ? config.recordingNickname : null).catch((e) => {
      console.warn('Nickname change failed:', e.message);
    });
  }
  function destroyConnection(connection) {
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  // Shared "the meeting's voice connection is gone for real" path — used by the
  // Disconnected/Destroyed recovery below. Idempotent: no-op if the session
  // already isn't active, and the re-entrancy guard prevents two concurrent
  // callers (e.g. Disconnected-timeout racing a Destroyed event) from both
  // trying to finalize the same key at once.
  async function finalizeLostConnection(guildId, channelId, connection, reason) {
    const key = `${guildId}:${channelId}`;
    if (finalizingLostConnections.has(key)) return;
    // Nothing to finalize — or the channel is already recording again on a
    // newer connection, which this stale one must not end.
    if (manager.connectionOf(guildId, channelId) !== connection) return;
    finalizingLostConnections.add(key);
    console.warn(`[voice] ${reason} for ${key} — finalizing the in-progress meeting.`);
    try {
      await stopAndLeave(guildId, channelId);
    } catch (err) {
      console.error(`[voice] failed to finalize lost connection ${key}:`, err.message);
    } finally {
      finalizingLostConnections.delete(key);
    }
  }

  // Recovery for the connection that backs a live meeting. Disconnected can be
  // a blip/region move or "gone for good": give it a short window to start
  // reconnecting and a bounded one to reach Ready, else end the meeting rather
  // than leave it 'recording' with no audio.
  function watchConnection(connection, guildId, channelId) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      const outcome = await waitForReconnect(connection);
      if (outcome === 'ready') {
        debugLog(`[voice] reconnected ${guildId}:${channelId}`);
        return;
      }
      console.warn(`[voice] Disconnected ${guildId}:${channelId} ${outcome === 'gone' ? 'did not start reconnecting' : 'did not get back to Ready'}`);
      await finalizeLostConnection(guildId, channelId, connection, 'Voice disconnected (no reconnect)');
      destroyConnection(connection);
    });
    // Safety net: torn down elsewhere (kicked, destroyed) without recovering.
    connection.on(VoiceConnectionStatus.Destroyed, async () => {
      await finalizeLostConnection(guildId, channelId, connection, 'Voice connection destroyed');
    });
  }

  function startMeeting(channel, connection) {
    const attendees = channel.members.filter((m) => !m.user.bot).map((m) => ({ id: m.id, displayName: m.displayName }));
    const meetingId = manager.start({ guildId: channel.guild.id, channelId: channel.id, channelName: channel.name, connection, guild: channel.guild, attendees });
    watchConnection(connection, channel.guild.id, channel.id);
    console.log(`[meeting] Started #${meetingId} in ${channel.name} with ${attendees.length} attendee(s)`);
    setRecIndicator(channel.guild, true);
  }

  // Join `channel` and start recording. Resolves 'started' | 'cancelled' (a stop
  // arrived during the join window) | 'busy' (this guild is already joining).
  // Throws when the join or the capture start fails; the connection is then
  // destroyed and auto-join backs off from this channel for a while.
  async function joinAndStart(channel) {
    const guildId = channel.guild.id;
    const active = manager.activeInGuild(guildId);
    if (active?.channelId === channel.id) return 'started';
    if (active) throw new Error(`Already recording <#${active.channelId}> in this server.`);
    // A stop still flushing holds the guild's one connection; joining now would
    // reuse it, and the stop would then destroy it under the new meeting.
    if (gate.isLeaving(guildId) || !gate.tryBeginJoin(guildId, channel.id)) {
      debugLog(`[join] ${guildId} is busy (joining ${gate.joiningChannel(guildId)}, leaving ${gate.isLeaving(guildId)})`);
      return 'busy';
    }
    let connection = null;
    try {
      connection = await connectToChannel(channel, { botUser: client.user, debugLog });
      if (gate.isCancelled(guildId) || !accepting) {
        console.log(`[meeting] Join of ${channel.name} cancelled before recording started.`);
        destroyConnection(connection);
        return 'cancelled';
      }
      startMeeting(channel, connection);
      gate.clearFailure(guildId, channel.id);
      return 'started';
    } catch (err) {
      gate.recordFailure(guildId, channel.id);
      destroyConnection(connection); // a failed start must not keep a live connection + listeners
      throw err;
    } finally {
      gate.endJoin(guildId);
    }
  }

  async function stopAndLeave(guildId, channelId) {
    console.log(`[meeting] Stopping meeting in guild:${guildId} channel:${channelId}`);
    gate.cancelLeave(guildId);
    // Capture THIS session's connection before stopping: a fresh per-guild
    // lookup could be a different (newer) connection.
    const connection = manager.connectionOf(guildId, channelId);
    gate.beginLeave(guildId);
    try {
      // stop() resolves as soon as capture is flushed; the transcribe/summarize
      // pipeline runs in the background (await result.done only if you must wait).
      const result = await manager.stop(guildId, channelId);
      const guild = client.guilds.cache.get(guildId);
      if (guild && result) setRecIndicator(guild, false);
      return result;
    } finally {
      destroyConnection(connection);
      gate.endLeave(guildId);
    }
  }

  function cancelJoin(guildId, channelId) {
    return gate.requestCancel(guildId, channelId);
  }

  // Called by the controller before stop/restart: refuse new recordings and
  // cancel in-flight joins while live meetings are flushed and finalized.
  function quiesce() {
    accepting = false;
    gate.clear();
  }

  async function autoLeaveIfStillEmpty(guildId, channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel || !manager.isActive(guildId, channelId)) return;
    const cfg = getGuildConfig(db, guildId);
    const minPeople = cfg.autoJoin ? cfg.autoJoinMinPeople : undefined;
    if (!shouldAutoLeave({ humanCount: humanCount(channel), connected: true, minPeople })) return;
    console.log(`[meeting] ${channel.name} stayed empty for ${AUTO_LEAVE_GRACE_MS / 1000}s — leaving.`);
    await stopAndLeave(guildId, channelId).catch((e) => console.error('auto-leave failed:', e.message));
    await autoJoinWaitingChannel(channel.guild);
  }

  // One recording per guild means a busy channel elsewhere may have been
  // skipped (e.g. the group moved channels together); pick it up now.
  async function autoJoinWaitingChannel(guild) {
    const cfg = getGuildConfig(db, guild.id);
    for (const channel of guild.channels.cache.values()) {
      if (manager.activeInGuild(guild.id) || gate.joiningChannel(guild.id)) return;
      if (channel.type === ChannelType.GuildVoice) await evaluateChannel(channel, cfg, true);
    }
  }

  // Re-evaluate one voice channel after a member moved. Auto-leave waits out a
  // grace period (a mobile reconnect must not split the meeting); auto-join
  // never targets a second channel while the guild already records or joins.
  async function evaluateChannel(voiceChannel, cfg, mayJoin) {
    const guildId = voiceChannel.guild.id;
    const connected = manager.isActive(guildId, voiceChannel.id);
    const count = humanCount(voiceChannel);
    const minPeople = cfg.autoJoin ? cfg.autoJoinMinPeople : undefined;
    debugLog(`[vSU] guild=${guildId} channel=${voiceChannel.id} humans=${count} connected=${connected} autoJoin=${cfg.autoJoin}`);
    if (shouldAutoLeave({ humanCount: count, connected, minPeople })) {
      if (gate.scheduleLeave(guildId, voiceChannel.id, () => autoLeaveIfStillEmpty(guildId, voiceChannel.id))) {
        debugLog(`[vSU] auto-leave in ${AUTO_LEAVE_GRACE_MS}ms unless people return to ${voiceChannel.id}`);
      }
      return;
    }
    if (connected) {
      if (gate.cancelLeave(guildId)) debugLog(`[vSU] participants returned to ${voiceChannel.id}; staying`);
      return;
    }
    if (!mayJoin || !accepting || gate.inBackoff(guildId, voiceChannel.id)) return;
    const guildBusy = Boolean(manager.activeInGuild(guildId) || gate.joiningChannel(guildId) || gate.isLeaving(guildId));
    if (shouldAutoJoin({
      humanCount: count, autoJoin: cfg.autoJoin, connected, minPeople, guildBusy,
      channelId: voiceChannel.id, allowedChannelIds: cfg.autoJoinChannelIds,
    })) {
      debugLog(`[vSU] auto-join triggered for ${voiceChannel.id}`);
      await joinAndStart(voiceChannel).catch((e) => console.error('auto-join failed:', e.message));
    }
  }

  // The bot's own voice state: a moderator dragging it into another channel
  // would otherwise file that channel's audio under the current meeting.
  async function handleOwnVoiceState(newState) {
    const guildId = newState.guild.id;
    const active = manager.activeInGuild(guildId);
    if (!botMovedAway({ activeChannelId: active?.channelId ?? null, newChannelId: newState.channelId })) return;
    console.warn(`[voice] Moved out of ${active.channelName} — ending meeting #${active.meetingId} instead of recording the new channel.`);
    await stopAndLeave(guildId, active.channelId).catch((e) => console.error('ending moved meeting failed:', e.message));
  }

  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Per-guild registration is instant; global is slow and cache-flaky (the
    // reason newly-added commands like /post showed up intermittently). Clear the
    // old global set so it can't shadow the guild commands, then register to every
    // guild the bot is in.
    await clearGlobalCommands().catch((e) => console.error('clear global commands failed:', e.message));
    for (const [guildId, guild] of client.guilds.cache) {
      // Persist the guild's human name so the web UI can label it even when read
      // without a live Discord client (e.g. the standalone API server).
      db.upsertGuild(guildId, guild.name);
      await deployCommands(config.discordClientId, config.discordToken, guildId)
        .then(() => console.log(`Registered commands in guild ${guildId}`))
        .catch((e) => console.error(`deploy to guild ${guildId} failed:`, e.message));
    }
    // Orphaned-meeting + audio-dir reconciliation now runs at process boot
    // (src/index.js → reconcileOnBoot) so it happens in web-only mode too, not
    // just when the bot logs in.
  });

  // Register commands when the bot joins a new guild, so they're available
  // immediately without waiting for a restart.
  client.on('guildCreate', (guild) => {
    db.upsertGuild(guild.id, guild.name);
    deployCommands(config.discordClientId, config.discordToken, guild.id)
      .then(() => console.log(`Registered commands in new guild ${guild.id}`))
      .catch((e) => console.error(`deploy to new guild ${guild.id} failed:`, e.message));
  });

  // Keep the stored guild name fresh when a server is renamed.
  client.on('guildUpdate', (_old, guild) => db.upsertGuild(guild.id, guild.name));

  client.on('voiceStateUpdate', async (oldState, newState) => {
    // An async listener's rejection is unhandled (and fatal on Node 22): contain it.
    try {
      if (newState.id === client.user?.id) return await handleOwnVoiceState(newState);
      const channel = newState.channel || oldState.channel;
      if (!channel) return;
      const cfg = getGuildConfig(db, newState.guild.id);
      for (const voiceChannel of new Set([oldState.channel, channel])) {
        if (voiceChannel?.type !== ChannelType.GuildVoice) continue;
        await evaluateChannel(voiceChannel, cfg, voiceChannel === channel);
      }
    } catch (err) {
      console.error('[vSU] voice state handling failed:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    // Model options are free text backed by the provider's live catalog. Answer
    // separately from commands: an autocomplete interaction can only be
    // respond()ed to, never replied to, so the command error path below
    // doesn't apply.
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction, { db, env: config });
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member } = interaction;
    try {
      if (commandName === 'join') {
        const vc = member.voice?.channel ?? null;
        const refusal = joinRefusal({
          channel: vc, accepting,
          activeChannelId: manager.activeInGuild(guild.id)?.channelId ?? null,
          joiningChannelId: gate.joiningChannel(guild.id),
        });
        if (refusal) return interaction.reply({ content: refusal, ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply(joinOutcomeReply(await joinAndStart(vc)));
      }
      if (commandName === 'leave') {
        const channelId = member.voice?.channel?.id;
        if (channelId && manager.isActive(guild.id, channelId)) {
          await interaction.deferReply({ ephemeral: true });
          await stopAndLeave(guild.id, channelId);
          return interaction.editReply('✅ Stopped. Processing — notes will post shortly.');
        }
        if (channelId && cancelJoin(guild.id, channelId)) {
          return interaction.reply({ content: "🛑 Cancelled — I was still joining, and I'll leave without recording.", ephemeral: true });
        }
        return interaction.reply({ content: "❌ I'm not recording here.", ephemeral: true });
      }
      if (commandName === 'summary') {
        const m = resolveGuildMeeting(db, guild.id, interaction.options.getInteger('meeting'));
        const s = m ? db.getSummary(m.id) : null;
        if (!s) return interaction.reply({ content: '❌ No summary found.', ephemeral: true });
        const cfg = getGuildConfig(db, guild.id);
        const parts = renderNotesChunks(s.notes, s.talktime, {
          channelName: m.channel_name, date: m.started_at,
          endedAt: m.ended_at,
          summaryLanguage: resolveSummaryLanguage(cfg),
        });
        await interaction.reply({ content: parts[0], ephemeral: true });
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ephemeral: true });
        return;
      }
      if (commandName === 'post') {
        const m = resolveGuildMeeting(db, guild.id, interaction.options.getInteger('meeting'));
        const s = m ? db.getSummary(m.id) : null;
        if (!s) return interaction.reply({ content: '❌ No summary found.', ephemeral: true });
        const cfg = getGuildConfig(db, guild.id);
        const parts = renderNotesChunks(s.notes, s.talktime, {
          channelName: m.channel_name, date: m.started_at,
          endedAt: m.ended_at,
          summaryLanguage: resolveSummaryLanguage(cfg),
        });
        await interaction.deferReply({ ephemeral: true });
        let target = interaction.channel;
        if (cfg.useThread && interaction.channel?.type === ChannelType.GuildText) {
          // Fall back to the channel itself if thread creation fails (e.g. missing perms).
          target = await interaction.channel.threads
            .create({ name: notesThreadName(m.channel_name, m.started_at) })
            .catch(() => interaction.channel);
        }
        for (const p of parts) await target.send(p);
        const where = target === interaction.channel ? 'this channel' : `thread <#${target.id}>`;
        return interaction.editReply(`✅ Posted summary for meeting #${m.id} in ${where}.`);
      }
      if (commandName === 'history') {
        return interaction.reply({ content: renderHistory(db.listRecent(guild.id, 10)), ephemeral: true });
      }
      if (commandName === 'status') {
        const content = renderStatus({ guildId: guild.id, active: manager.listActive(), recent: db.listRecent(guild.id, 5) });
        return interaction.reply({ content, ephemeral: true });
      }
      if (commandName === 'raw') {
        const m = resolveGuildMeeting(db, guild.id, interaction.options.getInteger('meeting'));
        if (!m) return interaction.reply({ content: '❌ No meeting found.', ephemeral: true });
        const attendees = db.listAttendees(m.id);
        const utterances = db.listUtterances(m.id);
        const summary = db.getSummary(m.id);
        const payload = {
          meeting: m,
          attendees: attendees.map((a) => ({ user_id: a.user_id, display_name: a.display_name })),
          utteranceCount: utterances.length,
          utterances: utterances.slice(0, 20).map((u) => ({ speaker: u.display_name, start_ms: u.start_ms, end_ms: u.end_ms, text: u.text })),
          summary: summary ? { model: summary.model_used, created: summary.created_at } : null,
        };
        const json = JSON.stringify(payload, null, 2);
        const parts = chunk(json, 1900);
        await interaction.reply({ content: '```json\n' + parts[0] + '\n```', ephemeral: true });
        for (const p of parts.slice(1)) await interaction.followUp({ content: '```json\n' + p + '\n```', ephemeral: true });
        return;
      }
      if (commandName === 'search') {
        const kw = interaction.options.getString('keyword');
        const hits = db.searchUtterances(guild.id, kw);
        if (!hits.length) return interaction.reply({ content: `No matches for "${kw}".`, ephemeral: true });
        const text = hits.slice(0, 10).map((h) => `#${h.meeting_id} ${h.display_name}: ${h.text}`).join('\n');
        return interaction.reply({ content: chunk(text)[0], ephemeral: true });
      }
      if (commandName === 'ask' || commandName === 'recap' || commandName === 'journal') {
        const campaign = resolveCampaign(db, guild.id, {
          campaign: interaction.options.getString('campaign'),
          voiceChannelId: member.voice?.channelId,
        });
        if (!campaign) {
          return interaction.reply({ content: '❌ No campaign found. An admin can create one with `/campaign create` (or on the dashboard\'s Campaigns page).', ephemeral: true });
        }
        if (commandName === 'journal') {
          const fresh = db.getCampaign(campaign.id);
          const body = fresh.journal?.trim() || '_The journal is empty. It fills in automatically after each session in this campaign._';
          const parts = chunk(`📜 **${fresh.name} — Campaign journal**\n\n${body}`);
          await interaction.reply({ content: parts[0], ephemeral: true });
          for (const p of parts.slice(1)) await interaction.followUp({ content: p, ephemeral: true });
          return;
        }
        const ephemeral = !interaction.options.getBoolean('public');
        await interaction.deferReply({ ephemeral });
        let text;
        if (commandName === 'ask') {
          const question = interaction.options.getString('question');
          const answer = await askCampaign(db, campaign.id, question);
          text = `**Q:** ${question}\n_${campaign.name}_\n\n${answer}`;
        } else {
          const recap = await recapCampaign(db, campaign.id, { sessions: interaction.options.getInteger('sessions') ?? 1 });
          text = `🎲 **Previously on ${campaign.name}…**\n\n${recap}`;
        }
        const parts = chunk(text);
        await interaction.editReply(parts[0]);
        for (const p of parts.slice(1)) await interaction.followUp({ content: p, ephemeral });
        return;
      }
      if (commandName === 'campaign') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
          const all = db.listCampaigns(guild.id);
          if (!all.length) return interaction.reply({ content: 'No campaigns yet. Create one with `/campaign create`.', ephemeral: true });
          const text = all.map((c) => {
            const chans = c.channels.length ? c.channels.map((ch) => `<#${ch.channel_id}>`).join(', ') : 'no linked channel';
            return `**${c.name}** — ${c.session_count} session${c.session_count === 1 ? '' : 's'} • ${chans}`;
          }).join('\n');
          return interaction.reply({ content: chunk(text)[0], ephemeral: true });
        }
        const vc = interaction.options.getChannel('voice_channel');
        const includePast = !!interaction.options.getBoolean('include_past');
        let campaign;
        if (sub === 'create') {
          const name = interaction.options.getString('name').trim();
          campaign = db.getCampaign(db.createCampaign({ guildId: guild.id, name }));
        } else {
          campaign = resolveCampaign(db, guild.id, { campaign: interaction.options.getString('campaign') });
          if (!campaign) return interaction.reply({ content: '❌ Campaign not found.', ephemeral: true });
        }
        let msg = sub === 'create' ? `✅ Created campaign **${campaign.name}**.` : `✅ Updated **${campaign.name}**.`;
        if (vc) {
          const attached = db.linkCampaignChannel(campaign.id, { guildId: guild.id, channelId: vc.id, channelName: vc.name, includePast });
          msg += ` Recordings in <#${vc.id}> now join it.`;
          if (attached) msg += ` Added ${attached} earlier recording${attached === 1 ? '' : 's'} — use **Update journal** on the dashboard's Campaigns page to fold ${attached === 1 ? 'it' : 'them'} into the journal.`;
        }
        return interaction.reply({ content: msg, ephemeral: true });
      }
      if (commandName === 'setup') {
        const input = {
          provider: interaction.options.getString('provider') ?? undefined,
          model: interaction.options.getString('model') ?? undefined,
          fallbackProvider: interaction.options.getString('fallback_provider') ?? undefined,
          fallbackModel: interaction.options.getString('fallback_model') ?? undefined,
          sttProvider: interaction.options.getString('stt_provider') ?? undefined,
          sttModel: interaction.options.getString('stt_model') ?? undefined,
          whisperModel: interaction.options.getString('whisper_model') ?? undefined,
          notesChannelId: interaction.options.getChannel('notes_channel')?.id,
          useThread: interaction.options.getBoolean('thread') ?? undefined,
          autoJoin: interaction.options.getBoolean('autojoin') ?? undefined,
          autoJoinMinPeople: interaction.options.getInteger('autojoin_min_people') ?? undefined,
          language: interaction.options.getString('language') ?? undefined,
          summary_language: interaction.options.getString('summary_language') ?? undefined,
        };
        const result = validateSetup(input, config, getGuildConfig(db, guild.id));
        if (!result.ok) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        const merged = setGuildConfig(db, guild.id, result.patch);
        return interaction.reply({ content: formatConfigReply(merged), ephemeral: true });
      }
    } catch (err) {
      console.error('interaction error:', err);
      const msg = `❌ Error: ${err.message}`;
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  });

  // Log in. A bad/expired token rejects this promise; without a catch that
  // becomes an unhandled rejection and kills the process (taking the web
  // dashboard down with it — the very tool meant to fix the token). Surface it
  // through the client's 'error' channel instead so the controller can report it.
  client.login(config.discordToken).catch((err) => {
    client.emit('error', err instanceof Error ? err : new Error(String(err)));
  });
  return { client, manager, stopAndLeave, cancelJoin, quiesce };
}
