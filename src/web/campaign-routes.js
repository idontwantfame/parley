// src/web/campaign-routes.js
// Dashboard API for campaigns (cross-session memory): a campaign groups
// sessions, keeps an LLM-maintained journal, and answers questions across all
// of its sessions. Voice channels link to a campaign so new recordings there
// join it automatically. Mounted onto the main router by apiRouter (api.js).
import { ChannelType } from 'discord.js';
import { config as env } from '../config/env.js';
import { catchUpJournal } from '../campaign/journal.js';
import { askCampaign, recapCampaign } from '../campaign/ask.js';
import { requireAdmin } from './auth.js';
import { journalEditConflict, questionOf } from './api-input.js';

const CAMPAIGN_LIST_LIMIT = 200;
const UNASSIGNED_LIMIT = 200;

const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

export function mountCampaignRoutes(r, { db, liveClient }) {
  const getCampaignOr404 = (req, res) => {
    const c = db.getCampaign(Number(req.params.id));
    if (!c) res.status(404).json({ error: 'campaign not found' });
    return c;
  };

  r.get('/guilds/:g/campaigns', (req, res) => {
    res.json(db.listCampaigns(req.params.g, { limit: CAMPAIGN_LIST_LIMIT })
      .map(({ journal, ...c }) => ({ ...c, has_journal: !!journal })));
  });

  r.post('/guilds/:g/campaigns', requireAdmin, (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = db.createCampaign({ guildId: req.params.g, name });
    let attached = 0;
    if (req.body?.channelId) {
      attached = db.linkCampaignChannel(id, { guildId: req.params.g, channelId: String(req.body.channelId),
        channelName: req.body.channelName ?? null, includePast: !!req.body.includePast });
    }
    res.json({ ok: true, campaign: db.getCampaign(id), attached });
  });

  // Voice channels to offer for linking: live ones from Discord, plus any
  // channel a meeting was ever recorded in (so it works with the bot offline).
  r.get('/guilds/:g/voice-channels', (req, res) => {
    const byId = new Map();
    const rows = db.sql.prepare(
      `SELECT channel_id, channel_name FROM meetings WHERE guild_id = ? AND channel_id IS NOT NULL
        AND source IS NOT 'import' GROUP BY channel_id ORDER BY MAX(started_at) DESC`
    ).all(req.params.g);
    for (const r0 of rows) byId.set(r0.channel_id, { id: r0.channel_id, name: r0.channel_name || r0.channel_id });
    const guild = liveClient()?.guilds?.cache?.get(req.params.g);
    if (guild) {
      for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) byId.set(ch.id, { id: ch.id, name: ch.name });
      }
    }
    const links = db.sql.prepare(`SELECT channel_id, campaign_id FROM campaign_channels WHERE guild_id = ?`).all(req.params.g);
    const linked = new Map(links.map((l) => [l.channel_id, l.campaign_id]));
    res.json([...byId.values()].map((c) => ({ ...c, campaignId: linked.get(c.id) ?? null })));
  });

  r.get('/campaigns/:id', (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    const sessions = db.listCampaignSessions(c.id).map(({ notes, ...m }) => ({
      ...m, tldr: notes?.tldr ?? null, has_summary: !!notes,
    }));
    // The guild's most recent meetings outside any campaign, for "Add sessions".
    const unassigned = db.listUnassignedMeetings(c.guild_id, UNASSIGNED_LIMIT);
    res.json({ campaign: c, channels: db.listCampaignChannels(c.id), sessions, unassigned });
  });

  // Rename and/or replace the journal. With `journalBase` (the
  // journal_updated_at the editor loaded) a journal edit is refused with 409
  // if a fold changed the journal meanwhile. Nothing is written on any error.
  r.patch('/campaigns/:id', requireAdmin, (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    const body = req.body ?? {};
    const name = body.name === undefined ? undefined : cleanName(body.name);
    if (name === '') return res.status(400).json({ error: 'name cannot be empty' });
    if (body.journal !== undefined) {
      const conflict = journalEditConflict(c, body);
      if (conflict) return res.status(conflict.status).json(conflict.body);
    }
    if (name !== undefined) db.renameCampaign(c.id, name);
    if (body.journal !== undefined) {
      const text = typeof body.journal === 'string' ? body.journal : '';
      db.setCampaignJournal(c.id, text.trim() ? text : null);
    }
    res.json({ ok: true, campaign: db.getCampaign(c.id) });
  });

  r.delete('/campaigns/:id', requireAdmin, (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    db.deleteCampaign(c.id);
    res.json({ ok: true });
  });

  r.post('/campaigns/:id/channels', requireAdmin, (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    const channelId = req.body?.channelId ? String(req.body.channelId) : '';
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    const attached = db.linkCampaignChannel(c.id, { guildId: c.guild_id, channelId,
      channelName: req.body.channelName ?? null, includePast: !!req.body.includePast });
    res.json({ ok: true, attached, channels: db.listCampaignChannels(c.id) });
  });

  r.delete('/campaigns/:id/channels/:channelId', requireAdmin, (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    if (!db.unlinkCampaignChannel(c.id, req.params.channelId)) {
      return res.status(404).json({ error: 'That channel is not linked to this campaign.' });
    }
    res.json({ ok: true, channels: db.listCampaignChannels(c.id) });
  });

  // Move a meeting into a campaign (campaignId) or out of one (null).
  r.put('/meetings/:id/campaign', requireAdmin, (req, res) => {
    const meeting = db.getMeeting(Number(req.params.id));
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    const campaignId = req.body?.campaignId == null ? null : Number(req.body.campaignId);
    if (campaignId != null) {
      const c = db.getCampaign(campaignId);
      if (!c) return res.status(404).json({ error: 'campaign not found' });
      if (c.guild_id !== meeting.guild_id) return res.status(400).json({ error: 'campaign belongs to a different server' });
    }
    db.setMeetingCampaign(meeting.id, campaignId);
    res.json({ ok: true, meeting: db.getMeeting(meeting.id) });
  });

  // Fold sessions that aren't in the journal yet (or, with rebuild, start the
  // journal over from every session). Runs in the background — one LLM call
  // per session — and the UI polls the campaign's journal_status.
  r.post('/campaigns/:id/journal/update', requireAdmin, (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    if (c.journal_status === 'updating') return res.status(409).json({ error: 'The journal is already being updated.' });
    catchUpJournal(db, c.id, { rebuild: !!req.body?.rebuild, env })
      .catch((e) => console.error(`[campaign] journal update for campaign ${c.id} failed: ${e.message}`));
    res.status(202).json({ ok: true, campaign: db.getCampaign(c.id) });
  });

  r.post('/campaigns/:id/ask', async (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    const question = questionOf(req.body);
    if (!question) return res.status(400).json({ error: 'question required' });
    try {
      res.json({ answer: await askCampaign(db, c.id, question, { env }) });
    } catch (e) { res.status(502).json({ error: e.userMessage || e.message }); }
  });

  r.post('/campaigns/:id/recap', async (req, res) => {
    const c = getCampaignOr404(req, res);
    if (!c) return;
    try {
      res.json({ recap: await recapCampaign(db, c.id, { sessions: req.body?.sessions, env }) });
    } catch (e) { res.status(502).json({ error: e.userMessage || e.message }); }
  });
}
