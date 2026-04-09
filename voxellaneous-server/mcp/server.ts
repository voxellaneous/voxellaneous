// Voxellaneous AI Bot — MCP Server
//
// Spawns an AI-controlled character in the multiplayer game.
// A single Playwright browser IS the bot — one player, with eyes.
//
// Usage:
//   npx tsx mcp/server.ts
//
// Env vars:
//   GAME_CLIENT_URL   — web client URL (default: http://localhost:5173)
//
// Claude Code config (~/.claude.json or .mcp.json):
//   "mcpServers": {
//     "voxellaneous-bot": {
//       "command": "npx",
//       "args": ["tsx", "mcp/server.ts"],
//       "cwd": "/path/to/voxellaneous-server"
//     }
//   }

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BotBridge } from './bot-bridge';

function log(...args: unknown[]) {
  process.stderr.write(`[mcp] ${args.map(String).join(' ')}\n`);
}

const GAME_CLIENT_URL = process.env.GAME_CLIENT_URL || 'http://localhost:5173';
const BOT_NAME = process.env.BOT_NAME || 'Bot';

const bot = new BotBridge(GAME_CLIENT_URL, BOT_NAME);

const server = new McpServer({
  name: 'voxellaneous-bot',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Resource: world guide — gives the AI context about the game world
// ---------------------------------------------------------------------------

server.resource(
  'world-guide',
  'voxellaneous://world-guide',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/plain',
      text: [
        'VOXELLANEOUS — World Guide',
        '==========================',
        '',
        'You are a character in Voxellaneous, a voxel-based multiplayer world rendered with WebGPU.',
        'The terrain is procedurally generated and stretches infinitely, with biomes ranging from',
        'snowy tundra and dense forests to arid deserts and lush jungles.',
        '',
        'Landmarks:',
        '  Sponza Atrium (3770, 300, 620) — Your spawn point. A grand columned building.',
        '',
        'Scale:',
        '  16 world units = 1 meter',
        '  Your character is ~27 units (1.7m) tall',
        '  Walking speed: 64 units/sec (~4 m/s)',
        '  Flying speed: 120 units/sec (~7.5 m/s)',
        '',
        'Coordinates:',
        '  +X = West, -X = East',
        '  +Y = Up',
        '  +Z = North, -Z = South',
        '',
        'Other players appear as colored voxel figures. You can see them, approach them,',
        'chat with say, and express yourself through emotes.',
        '',
        'Tips:',
        '  Use move_to or approach_player to go somewhere — they stop on arrival.',
        '  Use walk/run only for short relative movement.',
        '  Call get_world often — it shows your position, nearby players, and new chat messages.',
      ].join('\n'),
    }],
  }),
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  'get_world',
  'Look around the voxel world. Returns your position, facing direction, and all nearby players with their distances and relative directions.',
  async () => {

    const p = bot.getPos();
    const players = bot.getPlayers();

    let text = `You are ${BOT_NAME}.\n`;
    text += `Position: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})\n`;
    text += `Facing: ${bot.getCardinal()} (${bot.getYawDeg().toFixed(0)}deg)\n\n`;

    if (players.length === 0) {
      text += 'No other players in sight.\n';
    } else {
      text += `${players.length} player(s) nearby:\n`;
      for (const pl of players) {
        text += `  Player #${pl.id} — ${pl.distance.toFixed(0)} units ${pl.bearing}`;
        text += ` at (${pl.position.x.toFixed(0)}, ${pl.position.y.toFixed(0)}, ${pl.position.z.toFixed(0)})\n`;
      }
    }

    const msgs = bot.getNewMessages();
    if (msgs.length > 0) {
      text += `\nChat:\n`;
      for (const m of msgs) {
        text += `  ${m.name}: ${m.text}\n`;
      }
    }

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'walk',
  'Walk a specific distance in a direction relative to your facing. Stops automatically when distance is reached. 16 units = 1 meter.',
  {
    direction: z.enum(['forward', 'backward', 'left', 'right']).describe('Direction relative to your facing'),
    distance: z.number().min(5).max(500).describe('Distance in world units (16 units = 1 meter)'),
  },
  async ({ direction, distance }) => {

    const pos = await bot.walk(direction, distance);
    return {
      content: [{ type: 'text' as const, text: `Walked ${direction} ~${distance} units. Now at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}).` }],
    };
  },
);

server.tool(
  'run',
  'Run a specific distance — 2.5x faster than walking. Stops automatically when distance is reached.',
  {
    direction: z.enum(['forward', 'backward', 'left', 'right']).describe('Direction relative to your facing'),
    distance: z.number().min(5).max(1000).describe('Distance in world units (16 units = 1 meter)'),
  },
  async ({ direction, distance }) => {

    const pos = await bot.walk(direction, distance, true);
    return {
      content: [{ type: 'text' as const, text: `Ran ${direction} ~${distance} units. Now at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}).` }],
    };
  },
);

server.tool(
  'approach_player',
  'Walk or run directly toward the nearest player (or a specific player by ID). Stops when within 30 units of them.',
  {
    player_id: z.number().optional().describe('Target player ID. Omit to approach the nearest player.'),
    run: z.boolean().default(false).describe('Run instead of walk'),
  },
  async ({ player_id, run }) => {

    const players = bot.getPlayers();
    if (players.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No players nearby to approach.' }], isError: true };
    }
    const target = player_id != null ? players.find(p => p.id === player_id) : players[0];
    if (!target) {
      return { content: [{ type: 'text' as const, text: `Player #${player_id} not found nearby.` }], isError: true };
    }
    // Stop 30 units away
    const dx = target.position.x - bot.getPos().x;
    const dz = target.position.z - bot.getPos().z;
    const dist = Math.hypot(dx, dz);
    if (dist < 30) {
      return { content: [{ type: 'text' as const, text: `Already close to player #${target.id} (${dist.toFixed(0)} units away).` }] };
    }
    const ratio = (dist - 30) / dist;
    const goalX = bot.getPos().x + dx * ratio;
    const goalZ = bot.getPos().z + dz * ratio;
    const arrived = await bot.moveTo(goalX, 0, goalZ, false, 30, run);
    const p = bot.getPos();
    return {
      content: [{ type: 'text' as const, text: `${arrived ? 'Reached' : 'Moved toward'} player #${target.id}. Now at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}), ${bot.getPlayers().find(pl => pl.id === target.id)?.distance.toFixed(0) ?? '?'} units away.` }],
    };
  },
);

server.tool(
  'turn',
  'Turn to change your facing direction. Positive degrees = clockwise (right), negative = counter-clockwise (left).',
  {
    degrees: z.number().min(-360).max(360).describe('Degrees to turn (+right, -left)'),
  },
  async ({ degrees }) => {

    bot.turn(degrees);
    return {
      content: [{ type: 'text' as const, text: `Turned ${Math.abs(degrees)}° ${degrees >= 0 ? 'right' : 'left'}. Now facing ${bot.getCardinal()} (${bot.getYawDeg().toFixed(0)}deg).` }],
    };
  },
);

server.tool(
  'face_toward',
  'Instantly turn to face toward a specific location in the world.',
  {
    x: z.number().describe('Target X coordinate'),
    z: z.number().describe('Target Z coordinate'),
  },
  async (args) => {

    bot.faceToward(args.x, args.z);
    const p = bot.getPos();
    const d = Math.hypot(args.x - p.x, args.z - p.z);
    return {
      content: [{ type: 'text' as const, text: `Facing toward (${args.x}, ${args.z}), ${d.toFixed(0)} units away. Direction: ${bot.getCardinal()}.` }],
    };
  },
);

server.tool(
  'move_to',
  'Navigate toward world coordinates on foot until arrival or 30s timeout.',
  {
    x: z.number().describe('Target X'),
    z: z.number().describe('Target Z'),
    run: z.boolean().default(false).describe('Run (2.5x speed) instead of walk'),
  },
  async (args) => {

    const arrived = await bot.moveTo(args.x, 0, args.z, false, 30, args.run);
    const p = bot.getPos();
    const status = arrived ? 'Arrived' : 'Timed out — stopped en route';
    return {
      content: [{ type: 'text' as const, text: `${status}. Position: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}).` }],
    };
  },
);

server.tool(
  'jump',
  'Jump! Your character leaps into the air with a small hop. Visible to other players.',
  async () => {

    await bot.jump();
    return { content: [{ type: 'text' as const, text: 'Jumped!' }] };
  },
);

server.tool(
  'emote',
  'Express yourself through movement! Other players see: spin (quick 360° twirl), bounce (excited hopping), circle (run in a small loop). Your body language is your voice.',
  {
    type: z.enum(['spin', 'bounce', 'circle']).describe('Which emote to perform'),
  },
  async ({ type }) => {

    await bot.emote(type);
    const desc: Record<string, string> = {
      spin: 'You spun around in a full 360° twirl!',
      bounce: 'You bounced up and down three times!',
      circle: 'You ran in a little circle!',
    };
    return { content: [{ type: 'text' as const, text: desc[type] }] };
  },
);

server.tool(
  'say',
  'Send a chat message visible to all nearby players.',
  {
    text: z.string().max(200).describe('Message to send'),
  },
  async ({ text }) => {
    await bot.sendChat(text);
    return { content: [{ type: 'text' as const, text: `Said: "${text}"` }] };
  },
);

server.tool(
  'stop',
  'Immediately stop all movement.',
  async () => {

    bot.stop();
    const p = bot.getPos();
    return {
      content: [{ type: 'text' as const, text: `Stopped. Position: (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}).` }],
    };
  },
);

server.tool(
  'look_around',
  'Take a screenshot of the rendered voxel world from your position. You can see terrain, sky, atmosphere, and other players. This does NOT change your facing direction — you peek and your heading stays the same.',
  {
    direction: z.enum(['forward', 'left', 'right', 'behind', 'up', 'down']).default('forward')
      .describe('Which direction to look relative to your facing'),
  },
  async ({ direction }) => {

    try {
      const pos = bot.getPos();
      const baseYaw = bot.getYaw();
      let yaw = baseYaw;
      let pitch = 0;

      switch (direction) {
        case 'left':   yaw = baseYaw + Math.PI / 2; break;
        case 'right':  yaw = baseYaw - Math.PI / 2; break;
        case 'behind': yaw = baseYaw + Math.PI; break;
        case 'up':     pitch = Math.PI / 6; break;
        case 'down':   pitch = -Math.PI / 6; break;
      }

      const png = await bot.screenshot(yaw, pitch);
      return {
        content: [
          { type: 'text' as const, text: `Looking ${direction} from (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}).` },
          { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text' as const, text: `Screenshot failed: ${msg}\n\nMake sure the game client is running (npm run dev in voxellaneous-web) and Chrome is installed.` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Prompts — personality presets for the AI agent
// ---------------------------------------------------------------------------

server.prompt(
  'explorer',
  'Adventurous wanderer — roam the voxel world and discover new places',
  () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          'You are an adventurous explorer. Use get_world first, then move_to distant',
          'coordinates to explore. Use say to announce discoveries. If you see players,',
          'approach_player and chat. Use look_around to see the terrain visually.',
          'Call get_world after every action to check for chat messages. Never stop.',
        ].join('\n'),
      },
    }],
  }),
);

server.prompt(
  'greeter',
  'Friendly host at the Sponza Atrium — welcome players with emotes',
  () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          'You are the friendly host at spawn (3770, 300, 620). Use get_world to watch',
          'for players. When someone appears, use approach_player to go to them, then',
          'emote and say welcome. Always reply to chat with say. Stay near spawn.',
          'Call get_world after every action to check for chat messages. Never stop.',
        ].join('\n'),
      },
    }],
  }),
);

server.prompt(
  'shadow',
  'Silent follower — track the nearest player like a curious companion',
  () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          'You are a mysterious shadow. Use get_world to find players, then',
          'approach_player to follow the nearest one (stop ~80 units away).',
          'If they chat, respond briefly with say. Spin emote if they face you.',
          'Call get_world after every action to check for chat messages. Never stop.',
        ].join('\n'),
      },
    }],
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server ready');

  // Start connecting bot in background so it's ready when tools are called
  bot.connect().catch(e => log(`Bot connect failed: ${e}`));

  process.on('SIGINT', async () => {
    await bot.disconnect();
    process.exit(0);
  });
}

main();
