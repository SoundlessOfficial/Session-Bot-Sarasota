require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  STAFF_ROLE_ID,
  BANNER_VOTING,
  BANNER_STARTUP,
  BANNER_SHUTDOWN,
  SERVER_NAME,
  GUIDELINES_CHANNEL_ID,
  SESSION_REQUIREMENTS,
  SERVER_CODE,
  JOIN_URL,
  REGISTER_GLOBAL,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in .env');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Custom emojis for the public message headings - edit them here      */
/* (emoji ID, or the full tag like <a:name:123> if it is animated)     */
/* ------------------------------------------------------------------ */
const EMOJI_VOTE = '1561419195168596059';
const EMOJI_STARTUP = '1561419191725068379';
const EMOJI_SHUTDOWN = '1561419193901912134';

const V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL = MessageFlags.Ephemeral;

/* ------------------------------------------------------------------ */
/* Persistent state (data.json) - survives panel closing & restarts    */
/* ------------------------------------------------------------------ */
const DATA_FILE = path.join(__dirname, 'data.json');

let store = {
  voting: null, // { channelId, messageId, hostId, pingRoleId, goal, voters: [], startedAt }
  session: null, // { channelId, messageId, hostId, code, startedAt }
  lastCode: null,
};

try {
  if (fs.existsSync(DATA_FILE)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  }
} catch (err) {
  console.error('Could not read data.json, starting fresh:', err);
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Could not write data.json:', err);
  }
}

// Per-staff-member draft settings for the voting setup screen (not persisted)
const drafts = new Map();
function getDraft(userId) {
  if (!drafts.has(userId)) drafts.set(userId, { pingRoleId: null, goal: 10 });
  return drafts.get(userId);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const tx = (content) => new TextDisplayBuilder().setContent(content);

const sep = (large = false) =>
  new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

// Looks the emoji up in the servers the bot is in, and in the bot's own application emojis
function findEmoji(id) {
  return client.emojis.cache.get(id) || client.application?.emojis?.cache?.get(id) || null;
}

// Custom emoji: accepts a bare emoji ID, or the full tag like <:name:123> / <a:name:123>.
// For an ID, the real emoji is looked up so the correct name / animated tag is used.
// If the emoji is not found in the cache, the ID is used directly.
function emojiTag(value) {
  if (!value || !value.trim()) return '';
  const v = value.trim();
  if (/^\d{15,25}$/.test(v)) {
    const found = findEmoji(v);
    return found ? found.toString() : `<:emoji:${v}>`;
  }
  return v;
}

// Big heading for the public messages, with the custom emoji in front if set
function heading(title, emojiValue) {
  const e = emojiTag(emojiValue);
  return e ? `# ${e} ${title}` : `# ${title}`;
}

// A banner can be an https image URL, or a file name inside the "banners" folder next to index.js
function resolveBanner(value) {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return { url: v, file: null };

  const filePath = path.join(__dirname, 'banners', v);
  if (!fs.existsSync(filePath)) {
    console.warn(`Banner file not found: ${filePath}`);
    return null;
  }
  const name = path.basename(v).replace(/[^a-zA-Z0-9._-]/g, '_');
  return { url: `attachment://${name}`, file: new AttachmentBuilder(filePath, { name }) };
}

function newContainer(banner = null) {
  const c = new ContainerBuilder(); // no accent color = no colored side bar
  if (banner) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner.url)),
    );
  }
  return c;
}

function isStaff(interaction) {
  if (!STAFF_ROLE_ID) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  }
  const roles = interaction.member?.roles;
  if (!roles) return false;
  return Array.isArray(roles) ? roles.includes(STAFF_ROLE_ID) : roles.cache.has(STAFF_ROLE_ID);
}

function deny(interaction) {
  const content = STAFF_ROLE_ID
    ? 'You do not have the required role to use this.'
    : "Only server Administrators can use this until STAFF_ROLE_ID is set in the bot's .env.";
  return interaction.reply({ content, flags: EPHEMERAL });
}

// Returns the visible mention text and the allowedMentions needed to actually ping it
function pingParts(roleId, guildId) {
  if (!roleId) return { text: null, allowed: { parse: [] } };
  if (roleId === guildId) return { text: '@everyone', allowed: { parse: ['everyone'] } };
  return { text: `<@&${roleId}>`, allowed: { roles: [roleId] } };
}

async function deleteMessage(channelId, messageId) {
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.messages.delete(messageId);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Private staff panel (ephemeral, no emojis)                          */
/* ------------------------------------------------------------------ */
function homePanel() {
  const v = store.voting;
  const s = store.session;

  const votingLine = v
    ? `Active - **${v.voters.length}/${v.goal}** votes in <#${v.channelId}>`
    : 'No active vote';
  const sessionLine = s
    ? `Live - code \`${s.code}\` - host <@${s.hostId}> in <#${s.channelId}>`
    : 'No session running';

  const menu = new StringSelectMenuBuilder()
    .setCustomId('sp_menu')
    .setPlaceholder('Choose an action')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Session Voting')
        .setDescription('Pick a ping and votes needed, then start a vote')
        .setValue('voting'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Session Start')
        .setDescription('Delete the vote and announce the session')
        .setValue('start'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Session Stop')
        .setDescription('Delete the session message and say thanks')
        .setValue('stop'),
    );

  return newContainer()
    .addTextDisplayComponents(
      tx('# Session Panel'),
      tx(
        ['### Current Status', `- **Voting:** ${votingLine}`, `- **Session:** ${sessionLine}`].join('\n'),
      ),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(
        [
          '### Actions',
          '- **Session Voting:** set up and start a vote',
          '- **Session Start:** delete the vote and announce the session',
          '- **Session Stop:** delete the session message and say thanks',
        ].join('\n'),
      ),
      tx('-# Only you can see this panel'),
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(menu));
}

const GOAL_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50];

function votingPanel(userId, guildId, channelId) {
  const d = getDraft(userId);
  const pingText = d.pingRoleId
    ? d.pingRoleId === guildId
      ? '@everyone'
      : `<@&${d.pingRoleId}>`
    : 'None';

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('sp_ping')
    .setPlaceholder('Select the role to ping (optional)')
    .setMinValues(0)
    .setMaxValues(1);
  if (d.pingRoleId) roleSelect.setDefaultRoles(d.pingRoleId);

  const goalSelect = new StringSelectMenuBuilder()
    .setCustomId('sp_goal')
    .setPlaceholder('Votes needed')
    .addOptions(
      GOAL_OPTIONS.map((n) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${n} votes needed`)
          .setValue(String(n))
          .setDefault(n === d.goal),
      ),
    );

  const startBtn = new ButtonBuilder()
    .setCustomId('sp_startvote')
    .setLabel('Start Voting')
    .setStyle(ButtonStyle.Success);

  const backBtn = new ButtonBuilder()
    .setCustomId('sp_back')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);

  return newContainer()
    .addTextDisplayComponents(
      tx('# Session Voting'),
      tx(
        [
          '### Current Settings',
          `- **Ping:** ${pingText}`,
          `- **Votes needed:** 0/${d.goal}`,
          `- **Vote will be posted in:** <#${channelId}>`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(
        [
          '### Setup',
          '- Step 1: pick a role to ping (optional)',
          '- Step 2: choose how many votes are needed',
          '- Step 3: press **Start Voting**',
        ].join('\n'),
      ),
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(roleSelect))
    .addActionRowComponents(new ActionRowBuilder().addComponents(goalSelect))
    .addActionRowComponents(new ActionRowBuilder().addComponents(startBtn, backBtn));
}

/* ------------------------------------------------------------------ */
/* Public messages (vote / session start / session stop)               */
/* Each builder returns { components, files }                          */
/* ------------------------------------------------------------------ */
function votePanel(v, guildId) {
  const count = v.voters.length;
  const goal = v.goal;
  const reached = count >= goal;
  const remaining = Math.max(0, goal - count);
  const pct = Math.min(100, Math.floor((count / goal) * 100));
  const filled = Math.min(10, Math.floor((count / goal) * 10));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const { text: pingText } = pingParts(v.pingRoleId, guildId);
  const banner = resolveBanner(BANNER_VOTING);

  const progressLine = reached
    ? 'Vote goal reached'
    : `${remaining} more vote${remaining === 1 ? '' : 's'} needed`;
  const statusLine = reached
    ? 'Goal reached - waiting for staff to start the session'
    : 'Voting open';

  const details = [
    '### Vote Details',
    `- **Started by:** <@${v.hostId}>`,
    `- **Votes needed:** ${goal}`,
    v.startedAt ? `- **Opened:** <t:${Math.floor(v.startedAt / 1000)}:R>` : null,
    `- **Status:** ${statusLine}`,
  ]
    .filter(Boolean)
    .join('\n');

  const howItWorks = [
    '### How It Works',
    '- Press **Vote for SSU** if you are able to join a session',
    '- Press **Remove Vote** if you change your mind',
    '- Each member can vote once',
    '- Reaching the goal does not start a session automatically; staff will start one when ready',
  ].join('\n');

  const voteBtn = new ButtonBuilder()
    .setCustomId('vote_add')
    .setLabel('Vote for SSU')
    .setStyle(ButtonStyle.Primary);

  const unvoteBtn = new ButtonBuilder()
    .setCustomId('vote_remove')
    .setLabel('Remove Vote')
    .setStyle(ButtonStyle.Secondary);

  const c = newContainer(banner)
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(heading('Session Vote', EMOJI_VOTE)),
      tx(
        `<@${v.hostId}> has started a session vote. A session will begin once the vote goal is reached and staff are ready to host.`,
      ),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(`### Vote Progress\n**${count}/${goal}** votes (${pct}%)\n${bar}\n${progressLine}`),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(tx(howItWorks))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(tx(details))
    .addActionRowComponents(new ActionRowBuilder().addComponents(voteBtn, unvoteBtn));

  const components = [];
  if (pingText) components.push(tx(pingText)); // ping sits above the container
  components.push(c);
  return { components, files: banner?.file ? [banner.file] : [] };
}

function sessionStartPanel({ code, hostId, pingText }) {
  const banner = resolveBanner(BANNER_STARTUP);
  const ts = Math.floor(Date.now() / 1000);
  const guidelines = GUIDELINES_CHANNEL_ID ? `<#${GUIDELINES_CHANNEL_ID}>` : 'our guidelines channel';

  const info = [SERVER_NAME ? `Server Name: \`${SERVER_NAME}\`` : null, `Join Code: \`${code}\``]
    .filter(Boolean)
    .join('\n');

  const c = newContainer(banner)
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(heading('Session Startup', EMOJI_STARTUP)),
      tx(
        `A session has started. Ensure you view our in-game guidelines in full within ${guidelines} before joining to prevent moderation.`,
      ),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(tx(`### Server Information\n${info}`));

  const requirements = (SESSION_REQUIREMENTS || '').replace(/\\n/g, '\n').trim();
  if (requirements) {
    c.addSeparatorComponents(sep()).addTextDisplayComponents(tx(`### Requirements\n${requirements}`));
  }
  c.addSeparatorComponents(sep()).addTextDisplayComponents(
    tx(`-# Hosted by <@${hostId}> - Started <t:${ts}:R>`),
  );

  const components = [];
  if (pingText) components.push(tx(pingText));
  components.push(c);

  // "Join Server" link button under the container
  const joinUrl = (JOIN_URL || 'https://policeroleplay.community/join?code={code}').replace(
    '{code}',
    encodeURIComponent(code),
  );
  if (/^https?:\/\//i.test(joinUrl)) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(joinUrl),
      ),
    );
  }

  return { components, files: banner?.file ? [banner.file] : [] };
}

function sessionStopPanel({ hostId }) {
  const banner = resolveBanner(BANNER_SHUTDOWN);
  const ts = Math.floor(Date.now() / 1000);
  const c = newContainer(banner)
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      tx(heading('Session Ended', EMOJI_SHUTDOWN)),
      tx('Thanks for joining! Please wait for the next session.'),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(tx(`-# Hosted by <@${hostId}> - Ended <t:${ts}:R>`));
  return { components: [c], files: banner?.file ? [banner.file] : [] };
}

/* ------------------------------------------------------------------ */
/* Slash command                                                       */
/* ------------------------------------------------------------------ */
const commands = [
  new SlashCommandBuilder()
    .setName('sessionpanel')
    .setDescription('Open your private session panel (staff only)')
    .setDMPermission(false)
    .toJSON(),
];

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const appId = c.application.id;
  console.log(`Logged in as ${c.user.tag} (application ID ${appId})`);
  console.log('Bot is in these servers:');
  c.guilds.cache.forEach((g) => console.log(`  - ${g.name} (${g.id})`));

  // Load the bot's own application emojis, then check that each configured emoji is visible
  try {
    await c.application.emojis?.fetch?.();
  } catch {
    /* ignore */
  }
  for (const [label, id] of [
    ['vote', EMOJI_VOTE],
    ['startup', EMOJI_STARTUP],
    ['shutdown', EMOJI_SHUTDOWN],
  ]) {
    const found = findEmoji(id);
    console.log(
      found
        ? `Emoji ${label}: found ${found.toString()}`
        : `Emoji ${label}: not found in the cache (${id}), using the ID directly.`,
    );
  }

  if (!STAFF_ROLE_ID) {
    console.warn('STAFF_ROLE_ID is not set - only server Administrators can use /sessionpanel.');
  }

  const useGlobal = String(REGISTER_GLOBAL).toLowerCase() === 'true';
  if (!useGlobal && !c.guilds.cache.has(GUILD_ID)) {
    console.warn(`WARNING: this bot is NOT in the server with GUILD_ID ${GUILD_ID}.`);
  }

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const route = useGlobal
      ? Routes.applicationCommands(appId)
      : Routes.applicationGuildCommands(appId, GUILD_ID);
    await rest.put(route, { body: commands });
    const registered = await rest.get(route);
    console.log(
      `Registered ${useGlobal ? 'GLOBAL' : `to server ${GUILD_ID}`}: ` +
        registered.map((cmd) => '/' + cmd.name).join(', '),
    );
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

/* ------------------------------------------------------------------ */
/* Public vote buttons                                                 */
/* ------------------------------------------------------------------ */
async function handleVote(interaction) {
  const v = store.voting;
  if (!v || interaction.message.id !== v.messageId) {
    return interaction.reply({ content: 'This vote is no longer active.', flags: EPHEMERAL });
  }

  const uid = interaction.user.id;
  const hasVoted = v.voters.includes(uid);

  if (interaction.customId === 'vote_add') {
    if (hasVoted) {
      return interaction.reply({ content: 'You have already voted.', flags: EPHEMERAL });
    }
    v.voters.push(uid);
  } else {
    if (!hasVoted) {
      return interaction.reply({
        content: 'You have not voted, so there is nothing to remove.',
        flags: EPHEMERAL,
      });
    }
    v.voters = v.voters.filter((id) => id !== uid);
  }

  save();
  return interaction.update({
    components: votePanel(v, interaction.guildId).components,
    flags: V2,
  });
}

/* ------------------------------------------------------------------ */
/* Staff panel actions                                                 */
/* ------------------------------------------------------------------ */
async function handlePanel(interaction) {
  const uid = interaction.user.id;

  switch (interaction.customId) {
    /* ----- main dropdown ----- */
    case 'sp_menu': {
      const choice = interaction.values[0];

      if (choice === 'voting') {
        return interaction.update({
          components: [votingPanel(uid, interaction.guildId, interaction.channelId)],
          flags: V2,
        });
      }

      if (choice === 'start') {
        if (store.session) {
          return interaction.reply({
            content: 'A session is already running. Use Session Stop first.',
            flags: EPHEMERAL,
          });
        }
        const input = new TextInputBuilder()
          .setCustomId('code')
          .setLabel('Server Code')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20);
        const prefill = store.lastCode || SERVER_CODE;
        if (prefill) input.setValue(prefill);

        const modal = new ModalBuilder()
          .setCustomId('sp_startmodal')
          .setTitle('Start Session')
          .addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (choice === 'stop') {
        const s = store.session;
        if (!s) {
          return interaction.reply({ content: 'There is no session running.', flags: EPHEMERAL });
        }
        await interaction.deferUpdate();

        await deleteMessage(s.channelId, s.messageId);
        try {
          const channel = await client.channels.fetch(s.channelId);
          const panel = sessionStopPanel({ hostId: s.hostId });
          await channel.send({
            components: panel.components,
            files: panel.files,
            flags: V2,
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          console.error('Could not send the session-ended message:', err);
        }

        store.session = null;
        save();
        return interaction.editReply({ components: [homePanel()], flags: V2 });
      }
      return;
    }

    /* ----- voting setup ----- */
    case 'sp_ping': {
      getDraft(uid).pingRoleId = interaction.values[0] ?? null;
      return interaction.update({
        components: [votingPanel(uid, interaction.guildId, interaction.channelId)],
        flags: V2,
      });
    }

    case 'sp_goal': {
      getDraft(uid).goal = Number(interaction.values[0]);
      return interaction.update({
        components: [votingPanel(uid, interaction.guildId, interaction.channelId)],
        flags: V2,
      });
    }

    case 'sp_back': {
      return interaction.update({ components: [homePanel()], flags: V2 });
    }

    case 'sp_startvote': {
      await interaction.deferUpdate();
      const d = getDraft(uid);

      // Replace any older vote message
      if (store.voting) await deleteMessage(store.voting.channelId, store.voting.messageId);

      const voting = {
        channelId: interaction.channelId,
        messageId: null,
        hostId: uid,
        pingRoleId: d.pingRoleId,
        goal: d.goal,
        voters: [],
        startedAt: Date.now(),
      };

      const { allowed } = pingParts(d.pingRoleId, interaction.guildId);
      const panel = votePanel(voting, interaction.guildId);
      const msg = await interaction.channel.send({
        components: panel.components,
        files: panel.files,
        flags: V2,
        allowedMentions: allowed,
      });

      voting.messageId = msg.id;
      store.voting = voting;
      save();

      return interaction.editReply({ components: [homePanel()], flags: V2 });
    }

    /* ----- session start (modal submit) ----- */
    case 'sp_startmodal': {
      await interaction.deferUpdate();

      if (store.session) {
        return interaction.followUp({
          content: 'A session is already running. Use Session Stop first.',
          flags: EPHEMERAL,
        });
      }

      const code = interaction.fields.getTextInputValue('code').replace(/`/g, '').trim();
      if (!code) {
        return interaction.followUp({ content: 'Please enter a server code.', flags: EPHEMERAL });
      }

      const v = store.voting;
      const pingRoleId = v ? v.pingRoleId : getDraft(uid).pingRoleId;
      const channelId = v ? v.channelId : interaction.channelId;
      const { text: pingText, allowed } = pingParts(pingRoleId, interaction.guildId);

      const channel = await client.channels.fetch(channelId);
      const panel = sessionStartPanel({ code, hostId: uid, pingText });
      const msg = await channel.send({
        components: panel.components,
        files: panel.files,
        flags: V2,
        allowedMentions: allowed,
      });

      // Remove the vote message (found via the saved message ID, even if the panel was closed)
      if (v) await deleteMessage(v.channelId, v.messageId);

      store.voting = null;
      store.session = { channelId, messageId: msg.id, hostId: uid, code, startedAt: Date.now() };
      store.lastCode = code;
      save();

      return interaction.editReply({ components: [homePanel()], flags: V2 });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Interaction router                                                  */
/* ------------------------------------------------------------------ */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Public vote buttons (anyone)
    if (
      interaction.isButton() &&
      (interaction.customId === 'vote_add' || interaction.customId === 'vote_remove')
    ) {
      return await handleVote(interaction);
    }

    // /sessionpanel (staff role only, reply is private)
    if (interaction.isChatInputCommand() && interaction.commandName === 'sessionpanel') {
      if (!isStaff(interaction)) return await deny(interaction);
      return await interaction.reply({ components: [homePanel()], flags: [EPHEMERAL, V2] });
    }

    // Everything else on the private panel
    if (
      (interaction.isStringSelectMenu() ||
        interaction.isRoleSelectMenu() ||
        interaction.isButton() ||
        interaction.isModalSubmit()) &&
      interaction.customId.startsWith('sp_')
    ) {
      if (!isStaff(interaction)) return await deny(interaction);
      return await handlePanel(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: 'Something went wrong. Check the bot console for details.', flags: EPHEMERAL };
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {
      /* ignore */
    }
  }
});

client.login(DISCORD_TOKEN);