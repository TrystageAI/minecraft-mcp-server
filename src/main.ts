#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBot as createMineflayerBot, Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { plugin: pvpPlugin } = require('mineflayer-pvp') as any;
const { plugin: toolPlugin } = require('mineflayer-tool') as any;
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder') as any;
import { Vec3 } from 'vec3';
import { startAutoFight, stopAutoFight, getAutoFightStatus } from './autofight.js';

import { parseConfig } from './config.js';

const cliConfig = parseConfig();
const CONFIG = {
  host: cliConfig.host,
  port: cliConfig.port,
  username: cliConfig.username,
  password: process.env.MC_PASS || '',
  auth: (process.env.MC_AUTH || 'offline') as 'offline' | 'mojang' | 'microsoft',
  bedrock: process.env.MC_BEDROCK === 'true',
};

// --- Bot reference ---
let bot: Bot | null = null;

// --- Chat history ---
interface ChatMessage {
  sender: string;
  message: string;
  timestamp: number;
}
const chatHistory: ChatMessage[] = [];
const MAX_CHAT_HISTORY = 100;

function recordChat(sender: string, message: string) {
  chatHistory.push({ sender, message, timestamp: Date.now() });
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
  }
}

// --- Tool infrastructure ---
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const tools: Map<string, { def: ToolDefinition; handler: ToolHandler }> = new Map();

function registerTool(
  name: string,
  def: ToolDefinition,
  handler: ToolHandler,
): void {
  tools.set(name, { def, handler });
}

// --- Helpers ---

/** Stop any active pathfinder goal to prevent it from overriding look/movement */
function stopPathfinder(b: Bot | null): void {
  if (!b) return;
  try {
    (b as any).pathfinder?.setGoal(null);
  } catch { /* pathfinder not loaded */ }
}

/**
 * Safe lookAt: stops pathfinder first, has 3s timeout, falls back to direct yaw/pitch.
 * This prevents hangs when pathfinder is active from a previous timed-out move_to.
 */
async function safeLookAt(b: Bot | null, pos: Vec3, _force: boolean = true): Promise<void> {
  if (!b || !b.entity) return;
  stopPathfinder(b);

  // Use physics-based rotation: sets entity.yaw/pitch to target,
  // physics engine interpolates at 3rad/s and sends look packets each tick.
  // Promise resolves when rotation is complete (|yaw - lastSentYaw| < 0.001).
  // This guarantees the server has received the correct look direction.
  try {
    await Promise.race([
      b.lookAt(pos, false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lookAt timeout 5s')), 5000))
    ]);
  } catch (e) {
    // Fallback: force mode (sets lastSentYaw=target, physics won't send look packet)
    // Still better than nothing - _genericPlace/dig may still work
    try { await b.lookAt(pos, true); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
}

// --- Tool Registration ---

registerTool(
  'get_status',
  {
    name: 'get_status',
    description: '获取当前玩家状态（位置、血量、饥饿、经验）',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const pos = bot.entity.position;
    const blockPos = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const footBlock = new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z));
    return {
      position: bot.entity.position,
      blockPosition: { x: blockPos.x, y: blockPos.y, z: blockPos.z },
      footBlock: { x: footBlock.x, y: footBlock.y, z: footBlock.z },
      health: bot.health,
      food: bot.food,
      experience: bot.experience,
      onGround: bot.entity.onGround,
    };
  },
);

registerTool(
  'get_inventory',
  {
    name: 'get_inventory',
    description: '获取背包物品列表',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const items: Record<string, unknown>[] = [];
    bot.inventory.items().forEach((item) => {
      items.push({
        name: item.name,
        count: item.count,
        slot: item.slot,
      });
    });
    return { items };
  },
);

registerTool(
  'debug_inventory',
  {
    name: 'debug_inventory',
    description: 'Debug: 显示原始 inventory slots 状态（快捷栏 36-44 和当前选中槽位）',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const slots = bot.inventory.slots;
    const hotbar = slots.slice(36, 45).map((s, i) => s ? { slot: i, name: s.name, count: s.count } : null);
    const mainInv = slots.slice(9, 36).map((s, i) => s ? { slot: i + 9, name: s.name, count: s.count } : null);
    const selected = bot.inventory.selectedItem;
    const selectedSlot = bot.quickBarSlot;
    return {
      selectedSlot,
      selectedItem: selected ? { name: selected.name, count: selected.count } : null,
      hotbar,
      mainInv: mainInv.filter(Boolean),
    };
  },
);

registerTool(
  'find_block',
  {
    name: 'find_block',
    description: '在玩家周围寻找指定名称的方块',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '方块名称，如 stone, dirt, oak_log' },
        maxDistance: { type: 'number', description: '最大搜索距离，默认 16' },
      },
      required: ['name'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const name = String(args.name);
    const maxDistance = Number(args.maxDistance) || 16;
    const block = bot.findBlock({
      matching: (b: Block) => b.name === name,
      maxDistance,
    });
    if (!block) return { found: false };
    return { found: true, position: block.position, name: block.name };
  },
);

registerTool(
  'move_to',
  {
    name: 'move_to',
    description: '使用寻路算法移动到指定位置',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标' },
        y: { type: 'number', description: '目标 Y 坐标' },
        z: { type: 'number', description: '目标 Z 坐标' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const goal = new goals.GoalNear(x, y, z, 1);
    return new Promise((resolve) => {
      const b = bot!;
      let done = false;

      const onGoalReached = () => {
        if (done) return;
        done = true;
        clearInterval(checkRepath);
        clearTimeout(timer);
        stopPathfinder(b); // CRITICAL: stop pathfinder after reaching goal to prevent background movement
        resolve({ success: true, position: b.entity.position });
      };

      b.once('goal_reached', onGoalReached);
      b.pathfinder.setGoal(goal);

      const checkRepath = setInterval(() => {
        if ((b as any).pathfinder.repathCount > 10) {
          if (done) return;
          done = true;
          clearInterval(checkRepath);
          clearTimeout(timer);
          b.off('goal_reached', onGoalReached);
          resolve({ success: false, reason: 'Too many repaths' });
        }
      }, 1000);

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        clearInterval(checkRepath);
        b.off('goal_reached', onGoalReached);
        stopPathfinder(b); // CRITICAL: clear pathfinder goal so it doesn't block future lookAt
        resolve({ success: false, reason: 'Timeout' });
      }, 30000);
    });
  },
);

registerTool(
  'look_at',
  {
    name: 'look_at',
    description: '看向指定坐标',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标' },
        y: { type: 'number', description: '目标 Y 坐标' },
        z: { type: 'number', description: '目标 Z 坐标' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    await safeLookAt(bot, new Vec3(x, y, z), true);
    return { yaw: bot.entity?.yaw, pitch: bot.entity?.pitch };
  },
);

registerTool(
  'attack_entity',
  {
    name: 'attack_entity',
    description: '攻击指定实体（通过名称或类型）',
    inputSchema: {
      type: 'object',
      properties: {
        entityName: { type: 'string', description: '实体名称' },
        entityKind: { type: 'string', description: '实体类型，如 zombie, skeleton' },
      },
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const entityName = args.entityName ? String(args.entityName) : undefined;
    const entityKind = args.entityKind ? String(args.entityKind) : undefined;
    const entity = bot.nearestEntity((e) => {
      if (entityName && e.name !== entityName) return false;
      if (entityKind && e.name !== entityKind) return false;
      return true;
    });
    if (!entity) return { success: false, reason: 'Entity not found' };
    await safeLookAt(bot, entity.position, true);
    await bot.attack(entity);
    return { success: true, entityName: entity.name };
  },
);

registerTool(
  'start_auto_fight',
  {
    name: 'start_auto_fight',
    description: '开始自动战斗（自动攻击视野内的怪物）',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    startAutoFight(bot);
    return { started: true };
  },
);

registerTool(
  'stop_auto_fight',
  {
    name: 'stop_auto_fight',
    description: '停止自动战斗',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    stopAutoFight();
    return { stopped: true };
  },
);

registerTool(
  'get_auto_fight_status',
  {
    name: 'get_auto_fight_status',
    description: '获取自动战斗状态',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    return getAutoFightStatus();
  },
);

registerTool(
  'get_surrounding_entities',
  {
    name: 'get_surrounding_entities',
    description: '获取玩家周围的实体列表',
    inputSchema: {
      type: 'object',
      properties: {
        maxDistance: { type: 'number', description: '最大距离，默认 32' },
      },
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const maxDistance = Number(args.maxDistance) || 32;
    const entities: Record<string, unknown>[] = [];
    for (const [id, entity] of Object.entries(bot.entities)) {
      if (String(id) === String(bot.entity?.id)) continue;
      const dist = entity.position.distanceTo(bot.entity.position);
      if (dist <= maxDistance) {
        entities.push({
          id,
          name: entity.name,
          position: entity.position,
          distance: Math.round(dist * 100) / 100,
        });
      }
    }
    return { entities };
  },
);

registerTool(
  'chat',
  {
    name: 'chat',
    description: '在聊天栏发送消息',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发送的消息' },
      },
      required: ['message'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    if (typeof bot.chat !== 'function') return { error: 'Bot not ready (not in play state yet)' };
    const message = String(args.message);
    bot.chat(message);
    return { sent: message };
  },
);

registerTool(
  'get_block_at',
  {
    name: 'get_block_at',
    description: '获取指定坐标处的方块信息',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        z: { type: 'number', description: 'Z 坐标' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const block = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (!block) return { block: null };
    return {
      name: block.name,
      position: block.position,
      hardness: block.hardness,
    };
  },
);

registerTool(
  'equip',
  {
    name: 'equip',
    description: '装备指定物品',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '物品名称，如 diamond_sword' },
      },
      required: ['itemName'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const itemName = String(args.itemName);
    // bot.inventory has no findSlot - iterate slots directly
    // Skip armor slots (36-39) and offhand (45), only search 0-35 (main + hotbar)
    let foundItem: any = null;
    for (let s = 0; s < bot.inventory.slots.length; s++) {
      if (s >= 36 && s <= 39) continue; // skip armor
      if (s === 45) continue; // skip offhand
      const item = bot.inventory.slots[s];
      if (item && item.name === itemName) { foundItem = item; break; }
    }
    if (!foundItem) return { success: false, reason: `Item "${itemName}" not found in inventory` };
    try {
      await bot.equip(foundItem, 'hand');
      return { success: true, equipped: itemName };
    } catch (e: any) {
      return { success: false, reason: e.message };
    }
  },
);

registerTool(
  'walk_toward',
  {
    name: 'walk_toward',
    description: '朝指定坐标方向持续行走（不使用寻路，直接面朝目标往前走，用于靠近掉落物等）',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标' },
        y: { type: 'number', description: '目标 Y 坐标' },
        z: { type: 'number', description: '目标 Z 坐标' },
        durationSec: { type: 'number', description: '行走持续秒数，默认 3' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const duration = Number(args.durationSec) || 3;

    // Stop any active pathfinder first
    stopPathfinder(bot);

    // Look at target (safe, with timeout + fallback)
    await safeLookAt(bot, new Vec3(x, y, z), false);

    // Start moving forward
    const b = bot!;
    (b as any).setControlState('forward', true);
    (b as any).setControlState('sneak', false);

    // Walk for duration
    await new Promise((r) => setTimeout(r, duration * 1000));

    // Stop
    (b as any).setControlState('forward', false);

    return { success: true, finalPosition: b.entity.position };
  },
);

registerTool(
  'break_block',
  {
    name: 'break_block',
    description: '破坏/挖掘指定坐标的方块（自动面朝并持续挖掘直到破坏完成）',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        z: { type: 'number', description: 'Z 坐标' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    stopPathfinder(bot);
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const blockPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = bot.blockAt(blockPos);
    if (!block || block.name === 'air') {
      return { success: false, reason: 'No block at position or already air' };
    }
    const originalBlockName = block.name;

    // Distance check: if block is too far, return error (let agent use move_to first)
    if (!bot.canSeeBlock(block)) {
      const dist = bot.entity.position.distanceTo(blockPos);
      return { success: false, reason: `Too far to break (block at ${dist.toFixed(1)}m, need <5m). Use move_to to get closer first.` };
    }

    // Look at the block center (safe, stops pathfinder first)
    await safeLookAt(bot, blockPos, true);

    // Start mining with timeout protection
    // Hardness-based timeout: soft blocks 5s, stone 30s, obsidian 120s
    const hardness = block.hardness ?? 1;
    const timeoutMs = Math.min(120000, Math.max(5000, hardness * 15000));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          bot!.control.digging = false; // stop digging
          reject(new Error(`dig timed out after ${timeoutMs / 1000}s (hardness: ${hardness})`));
        }, timeoutMs);
        bot!.dig(block, true).then(() => { clearTimeout(timer); resolve(); }).catch((e) => { clearTimeout(timer); reject(e); });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, reason: `dig failed: ${msg}` };
    }

    // dig() resolves when block is fully broken
    return { success: true, brokenBlock: originalBlockName, position: blockPos };
  },
);

// --- MCP Server ---

const server = new Server(
  {
    name: 'mc-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Array.from(tools.entries()).map(([, { def }]) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const params = request.params as { name: string; arguments?: Record<string, unknown> };
  const tool = tools.get(params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
  }
  try {
    const result = await tool.handler(params.arguments || {}) as any;
    // Support image responses: if result contains __image, return image content
    if (result && result.__image) {
      const { __image, __mimeType, ...rest } = result;
      const content: any[] = [
        { type: 'image', data: __image, mimeType: __mimeType || 'image/png' },
      ];
      if (Object.keys(rest).length > 0) {
        content.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
      }
      return { content };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// --- Mineflayer Bot ---

function createBot(): Bot {
  const b = createMineflayerBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    ...(CONFIG.auth !== 'offline' ? { password: CONFIG.password } : {}),
  });

  b.once('error', (err: Error) => {
    console.error('[Bot] Error:', err.message);
  });

  b.once('end', () => {
    console.error('[Bot] Connection ended');
  });

  b.loadPlugin(pvpPlugin);
  b.loadPlugin(toolPlugin);

  b.on('kicked', (reason: string) => {
    console.error('[Bot] Kicked:', reason);
  });

  b.on('spawn', () => {
    console.error(`[Bot] Spawned at ${b.entity.position}`);
    (b as any).loadPlugin(pathfinder, {
      movements: new (Movements as any)(b),
      allowDiagonals: true,
    });
  });

  b.on('login', () => {
    console.error('[Bot] Logged in as', CONFIG.username);
  });

  b.on('health', () => {
    if (b.health === 0) {
      console.error('[Bot] Died!');
    }
  });

  b.on('message', (msg: any) => {
    const text = typeof msg === 'string' ? msg : msg?.toString?.() || '';
    const sender = msg?.username || 'Server';
    recordChat(sender, text);
  });

  b.on('messagestr', (msg: string) => {
    recordChat('Server', msg);
  });

  return b;
}

registerTool(
  'place_block',
  {
    name: 'place_block',
    description: '在指定位置放置方块。可指定itemName从背包自动取用，也会自动寻找相邻方块作为参考面。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标' },
        y: { type: 'number', description: '目标 Y 坐标' },
        z: { type: 'number', description: '目标 Z 坐标' },
        itemName: { type: 'string', description: '要放置的物品名称（如 crafting_table），不填则使用当前手持' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    stopPathfinder(bot);
    const x = Math.floor(Number(args.x));
    const y = Math.floor(Number(args.y));
    const z = Math.floor(Number(args.z));
    const itemName = args.itemName ? String(args.itemName) : null;

    // If itemName provided, make sure it's in hand
    if (itemName) {
      const itemData = (bot.registry as any).itemsByName?.[itemName];
      if (!itemData) return { error: `Item "${itemName}" not found in registry` };
      // Check if already in selected hotbar slot (bot.heldItem, not selectedItem!)
      const held = bot.heldItem as any;
      if (!held || held.name !== itemName) {
        // Find item in inventory (scan all slots)
        let invSlot = -1;
        for (let s = 0; s < bot.inventory.slots.length; s++) {
          const item = bot.inventory.slots[s];
          if (item && item.name === itemName) { invSlot = s; break; }
        }
        if (invSlot === -1) return { error: `Item "${itemName}" not found in inventory` };
        // Find an empty hotbar slot (indices 36-44 in bot.inventory.slots)
        let targetSlot = -1;
        for (let s = 36; s < 45; s++) {
          if (!bot.inventory.slots[s]) { targetSlot = s; break; }
        }
        if (targetSlot === -1) return { error: 'No empty hotbar slot available' };
        try {
          // Move with timeout protection (5s max)
          const movePromise = bot.moveSlotItem(invSlot, targetSlot);
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('move timeout')), 5000));
          await Promise.race([movePromise, timeout]);
          await new Promise(r => setTimeout(r, 300));
          bot.setQuickBarSlot(targetSlot - 36);
          await new Promise(r => setTimeout(r, 100));
        } catch (e: any) {
          const msg = e instanceof Error ? e.message : String(e);
          return { error: `Failed to move item to hotbar: ${msg}` };
        }
      }
    }

    // Non-solid blocks that can't be used as reference for placing,
    // but CAN be replaced by placing a solid block on them
    const nonSolidBlocks = new Set([
      'short_grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy',
      'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
      'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lilac', 'rose_bush',
      'pitcher_plant', 'wither_rose', 'sunflower', 'lily_pad', 'vine', 'glow_lichen',
      'seagrass', 'tall_seagrass', 'kelp', 'dead_bush', 'brown_mushroom', 'red_mushroom',
      'snow', 'fire', 'lava', 'water', 'bubble_column',
    ]);

    // Check target is air or a non-solid block (which can be replaced)
    const target = bot.blockAt(new Vec3(x, y, z));
    if (target && target.name !== 'air' && target.name !== 'cave_air' && target.name !== 'void_air' && !nonSolidBlocks.has(target.name)) {
      return { error: `Target position is not air (it's ${target.name})` };
    }

    function isPlaceableReference(block: any): boolean {
      if (!block) return false;
      if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return false;
      if (nonSolidBlocks.has(block.name)) return false;
      return true;
    }

    // Reference block offsets (direction from target to reference)
    // faceVector points from reference TOWARD target (opposite of offset)
    const faceDirs = [
      { dx: 0, dy: -1, dz: 0, fv: new Vec3(0, 1, 0) },   // ref below target → place above ref
      { dx: 0, dy: 1, dz: 0, fv: new Vec3(0, -1, 0) },   // ref above target → place below ref
      { dx: 0, dy: 0, dz: -1, fv: new Vec3(0, 0, 1) },   // ref north of target → place south of ref
      { dx: 0, dy: 0, dz: 1, fv: new Vec3(0, 0, -1) },   // ref south of target → place north of ref
      { dx: -1, dy: 0, dz: 0, fv: new Vec3(1, 0, 0) },   // ref west of target → place east of ref
      { dx: 1, dy: 0, dz: 0, fv: new Vec3(-1, 0, 0) },   // ref east of target → place west of ref
    ];

    // Helper: set look direction properly using physics-based rotation.
    // bot.lookAt(pos) without force:
    //   - sets entity.yaw/pitch to target
    //   - physics engine interpolates at 3rad/s, sending look packets each tick
    //   - promise resolves when |entity.yaw - lastSentYaw| < 0.001 (rotation complete)
    //   - guarantees server has received the correct look direction
    // stopPathfinder() is called at the top of this function, so lookAt won't be interrupted.
    async function lookAtTarget(pos: Vec3): Promise<void> {
      try {
        await Promise.race([
          bot.lookAt(pos, false),
          new Promise((_, reject) => setTimeout(() => reject(new Error('lookAt timeout 5s')), 5000))
        ]);
      } catch (e) {
        console.error(`[place_block] lookAtTarget issue: ${e instanceof Error ? e.message : String(e)}`);
        // Fallback: force mode (sets lastSent too, but _genericPlace still works)
        try { await bot.lookAt(pos, true); } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
    }

    for (const fd of faceDirs) {
      const refX = x + fd.dx, refY = y + fd.dy, refZ = z + fd.dz;
      const neighbor = bot.blockAt(new Vec3(refX, refY, refZ));
      if (!isPlaceableReference(neighbor)) continue;

      // Distance check
      if (!bot.canSeeBlock(neighbor)) {
        const dist = bot.entity.position.distanceTo(neighbor.position);
        return { error: `Too far to place (ref "${neighbor.name}" at ${dist.toFixed(1)}m). Use move_to first.`, refPos: { x: refX, y: refY, z: refZ } };
      }

      // Set look direction to the face center - wait for physics rotation to complete
      const lookTarget = new Vec3(refX + 0.5, refY + 0.5, refZ + 0.5);
      await lookAtTarget(lookTarget);
      // Small delay for last look packet to reach server
      await new Promise(r => setTimeout(r, 150));

      // Use mineflayer's _genericPlace with forceLook:'ignore' to skip the hanging lookAt
      // This handles all protocol details (direction, cursor, sequence, worldBorderHit, etc.)
      let placeError = '';
      try {
        await (bot as any)._genericPlace(neighbor, fd.fv, { forceLook: 'ignore', swingArm: 'right' });
      } catch (e: any) {
        placeError = e instanceof Error ? e.message : String(e);
        console.error(`[place_block] _genericPlace failed (ref ${neighbor.name} at ${refX},${refY},${refZ}): ${placeError}`);
        continue;
      }

      // Wait for server to process and verify
      await new Promise(r => setTimeout(r, 800));
      const placed = bot.blockAt(new Vec3(x, y, z));
      // Verification: block must have changed from original state
      const wasAir = !target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air';
      if (wasAir) {
        // Was air: any non-air block means success
        if (placed && placed.name !== 'air' && placed.name !== 'cave_air' && placed.name !== 'void_air') {
          return { success: true, placedAt: { x, y, z }, placedBlock: placed.name, referenceBlock: neighbor.name };
        }
      } else {
        // Was non-solid (e.g. short_grass): block must have CHANGED
        if (placed && placed.name !== target.name && placed.name !== 'air') {
          return { success: true, placedAt: { x, y, z }, placedBlock: placed.name, referenceBlock: neighbor.name, replaced: target.name };
        }
      }

      // If not placed, log and try next direction
      console.error(`[place_block] Placement not verified. Target (${x},${y},${z}) still has: ${placed?.name || 'air'}. Ref: ${neighbor.name}. Error: ${placeError || 'none'}`);
      continue;
    }

    return { error: 'Failed to place block. No valid reference found or placement was rejected by server. Check that target is air and you have the item in hand.' };
  },
);

registerTool(
  'debug_place',
  {
    name: 'debug_place',
    description: 'Debug: diagnose block placement issues. Tests different placement methods and reports detailed state.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
        z: { type: 'number', description: 'Target Z' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Math.floor(Number(args.x));
    const y = Math.floor(Number(args.y));
    const z = Math.floor(Number(args.z));
    const results: Record<string, unknown> = {};

    // 1. Current state
    results.botPos = bot.entity.position;
    results.heldItem = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null;
    results.selectedSlot = bot.inventory.selectedSlot;
    results.quickBarSlot = bot.quickBarSlot;
    const hotbar = [];
    for (let s = 36; s < 45; s++) {
      const item = bot.inventory.slots[s];
      hotbar.push(item ? { slot: s - 36, name: item.name, count: item.count } : null);
    }
    results.hotbar = hotbar;

    // 2. Target block
    const target = bot.blockAt(new Vec3(x, y, z));
    results.targetBlock = target?.name || 'null';

    // 3. Try to find a reference and test placement
    const faceDirs = [
      { dx: 0, dy: -1, dz: 0, fv: [0, 1, 0], label: 'above_ref_below' },
      { dx: 0, dy: 0, dz: -1, fv: [0, 0, 1], label: 'south_of_ref_north' },
      { dx: 0, dy: 0, dz: 1, fv: [0, 0, -1], label: 'north_of_ref_south' },
      { dx: -1, dy: 0, dz: 0, fv: [1, 0, 0], label: 'east_of_ref_west' },
      { dx: 1, dy: 0, dz: 0, fv: [-1, 0, 0], label: 'west_of_ref_east' },
    ];

    for (const fd of faceDirs) {
      const refX = x + fd.dx, refY = y + fd.dy, refZ = z + fd.dz;
      const neighbor = bot.blockAt(new Vec3(refX, refY, refZ));
      if (!neighbor || neighbor.name === 'air' || neighbor.name === 'cave_air') continue;

      const dist = bot.entity.position.distanceTo(neighbor.position);
      const canSee = bot.canSeeBlock(neighbor);

      results[`ref_${fd.label}`] = {
        name: neighbor.name,
        pos: { x: refX, y: refY, z: refZ },
        distance: Math.round(dist * 100) / 100,
        canSee: canSee,
      };

      if (!canSee) continue;

      // Try method 1: bot.activateBlock (sends use_on packet)
      try {
        console.error(`[debug_place] Trying activateBlock on ${neighbor.name} at ${refX},${refY},${refZ}`);
        await bot.activateBlock(neighbor);
        await new Promise(r => setTimeout(r, 500));
        const afterActivate = bot.blockAt(new Vec3(x, y, z));
        results[`activateBlock_${fd.label}`] = {
          result: 'called successfully',
          targetAfter: afterActivate?.name || 'air',
        };
        if (afterActivate && afterActivate.name !== 'air' && afterActivate.name !== target?.name) {
          results.success = 'activateBlock worked!';
          return results;
        }
      } catch (e: any) {
        results[`activateBlock_${fd.label}`] = { error: e.message };
      }

      // Try method 2: bot.placeBlock (standard API with timeout)
      try {
        const faceVec = new Vec3(fd.fv[0], fd.fv[1], fd.fv[2]);
        console.error(`[debug_place] Trying bot.placeBlock on ${neighbor.name} at ${refX},${refY},${refZ} face=${faceVec}`);
        await Promise.race([
          bot.placeBlock(neighbor, faceVec),
          new Promise((_, rej) => setTimeout(() => rej(new Error('placeBlock timeout 6s')), 6000)),
        ]);
        await new Promise(r => setTimeout(r, 500));
        const afterPlace = bot.blockAt(new Vec3(x, y, z));
        results[`placeBlock_${fd.label}`] = {
          result: 'placeBlock resolved',
          targetAfter: afterPlace?.name || 'air',
        };
        if (afterPlace && afterPlace.name !== 'air' && afterPlace.name !== target?.name) {
          results.success = 'placeBlock worked!';
          return results;
        }
      } catch (e: any) {
        results[`placeBlock_${fd.label}`] = { error: e.message };
      }

      break; // Only try the first valid reference
    }

    return results;
  },
);

registerTool(
  'craft_item',
  {
    name: 'craft_item',
    description: '合成/制作指定物品。会自动寻找配方，需要工作台时会自动使用。',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '要合成的物品名称，如 wooden_pickaxe, iron_sword, oak_planks' },
        count: { type: 'number', description: '要合成的数量，默认 1' },
      },
      required: ['itemName'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const itemName = String(args.itemName);
    const count = Number(args.count) || 1;

    // Get item ID from name
    const itemData = (bot.registry as any).itemsByName?.[itemName];
    if (!itemData) return { error: `Item "${itemName}" not found in registry` };

    const itemId = itemData.id;
    // Get recipes (pass true for craftingTable to include table recipes)
    const recipes = bot.recipesFor(itemId, null, count, true as any);
    if (!recipes || recipes.length === 0) {
      return { error: `No recipe found for "${itemName}"` };
    }

    const recipe = recipes[0];
    let craftingTable: any = null;
    if (recipe.requiresTable) {
      const table = bot.findBlock({
        matching: (b: Block) => b.name === 'crafting_table',
        maxDistance: 16,
      });
      if (!table) return { error: 'Recipe requires crafting table but none found within 16 blocks' };
      craftingTable = table;
    }

    try {
      await bot.craft(recipe, count, craftingTable);
      return { success: true, crafted: itemName, count, requiredTable: !!recipe.requiresTable };
    } catch (e: any) {
      return { error: `Craft failed: ${e.message}` };
    }
  },
);

registerTool(
  'eat',
  {
    name: 'eat',
    description: '吃当前手持物品（食物）。需要先确保手持的是食物。',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    try {
      await bot.consume();
      return { success: true, health: bot.health, food: bot.food };
    } catch (e: any) {
      return { error: `Eat failed: ${e.message}` };
    }
  },
);

registerTool(
  'discard_item',
  {
    name: 'discard_item',
    description: '丢弃指定物品到地面',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '要丢弃的物品名称' },
        count: { type: 'number', description: '丢弃数量，null 表示全部' },
      },
      required: ['itemName'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const itemName = String(args.itemName);
    const count = args.count != null ? Number(args.count) : null;

    const itemData = (bot.registry as any).itemsByName?.[itemName];
    if (!itemData) return { error: `Item "${itemName}" not found` };

    try {
      await bot.toss(itemData.id, null, count);
      return { success: true, discarded: itemName, count: count ?? 'all' };
    } catch (e: any) {
      return { error: `Discard failed: ${e.message}` };
    }
  },
);

registerTool(
  'get_game_info',
  {
    name: 'get_game_info',
    description: '获取游戏信息（时间、天气、维度、游戏模式、在线玩家、难度）',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const t = bot.time;
    const timeOfDay = t.timeOfDay;
    const hours = Math.floor(timeOfDay / 1000);
    const minutes = Math.floor((timeOfDay % 1000) / 1000 * 60);
    const playerNames = Object.values(bot.players).map((p: any) => ({
      name: p.username,
      gamemode: p.gamemode,
    }));
    return {
      gameMode: bot.game.gameMode,
      dimension: bot.game.dimension,
      difficulty: bot.game.difficulty,
      time: `${hours}:${minutes.toString().padStart(2, '0')}`,
      isDaytime: t.isDay,
      isRaining: bot.isRaining,
      onlinePlayers: playerNames,
    };
  },
);

registerTool(
  'get_potions',
  {
    name: 'get_potions',
    description: '获取当前所有药水效果（buff/debuff）',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const b = bot;
    const effects = b.entity.effects || [];
    return {
      effects: effects.map((e: any) => ({
        id: e.id,
        amplifier: e.amplifier,
        duration: e.duration,
        name: (b.registry as any).enchantments?.[e.id]?.name || `effect_${e.id}`,
      })),
    };
  },
);

registerTool(
  'open_container',
  {
    name: 'open_container',
    description: '打开指定位置的容器（箱子/熔炉/工作台等）',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        z: { type: 'number', description: 'Z 坐标' },
      },
      required: ['x', 'y', 'z'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const x = Math.floor(Number(args.x));
    const y = Math.floor(Number(args.y));
    const z = Math.floor(Number(args.z));
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return { error: 'No block at position' };

    const blockName = block.name;
    try {
      if (blockName === 'chest' || blockName === 'trapped_chest' || blockName === 'barrel') {
        const chest = await bot.openChest(block);
        return { success: true, type: 'chest', blockName };
      } else if (blockName === 'furnace' || blockName === 'blast_furnace' || blockName === 'smoker') {
        const furnace = await bot.openFurnace(block);
        return { success: true, type: 'furnace', blockName };
      } else if (blockName === 'crafting_table') {
        const window = await bot.activateBlock(block);
        return { success: true, type: 'crafting_table', blockName };
      } else if (blockName === 'hopper') {
        return { error: 'Hopper cannot be opened directly' };
      } else {
        return { error: `Block "${blockName}" is not an openable container` };
      }
    } catch (e: any) {
      return { error: `Failed to open: ${e.message}` };
    }
  },
);

registerTool(
  'get_container_items',
  {
    name: 'get_container_items',
    description: '获取当前打开的容器中的物品列表',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const window = bot.currentWindow;
    if (!window) return { error: 'No container open' };
    const items = window.slots
      .map((item: any, index: number) => item ? { slot: index, name: item.name, count: item.count, type: item.type } : null)
      .filter(Boolean);
    return { windowType: window.type, items };
  },
);

registerTool(
  'close_container',
  {
    name: 'close_container',
    description: '关闭当前打开的容器',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    if (!bot.currentWindow) return { error: 'No container open' };
    bot.closeWindow(bot.currentWindow);
    return { success: true };
  },
);

registerTool(
  'take_from_container',
  {
    name: 'take_from_container',
    description: '从当前打开的容器指定槽位取出物品到背包',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'number', description: '容器中的槽位号（从 get_container_items 获取）' },
        count: { type: 'number', description: '取出数量，0 表示全部' },
      },
      required: ['slot'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const window = bot.currentWindow;
    if (!window) return { error: 'No container open' };
    const slot = Number(args.slot);
    const count = Number(args.count) || 0;
    const item = window.slots[slot];
    if (!item) return { error: `Slot ${slot} is empty` };

    try {
      if (count === 0) {
        // Take all: shift-click
        await bot.clickWindow(slot, 0, 1); // mode 1 = shift
      } else {
        // Take specific count
        for (let i = 0; i < count; i++) {
          if (!window.slots[slot]) break;
          await bot.clickWindow(slot, 0, 0);
        }
      }
      return { success: true, taken: item.name, slot };
    } catch (e: any) {
      return { error: `Take failed: ${e.message}` };
    }
  },
);

registerTool(
  'put_in_container',
  {
    name: 'put_in_container',
    description: '将背包中的物品放入当前打开的容器',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '要放入的物品名称' },
        count: { type: 'number', description: '放入数量，0 表示全部' },
      },
      required: ['itemName'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const window = bot.currentWindow;
    if (!window) return { error: 'No container open' };
    const itemName = String(args.itemName);
    const count = Number(args.count) || 0;

    const itemData = (bot.registry as any).itemsByName?.[itemName];
    if (!itemData) return { error: `Item "${itemName}" not found` };

    // Find the item in player inventory
    const invItem = bot.inventory.findItemRange(9, 35, itemData.id, null, false, null);
    if (!invItem) return { error: `Item "${itemName}" not found in inventory` };

    try {
      if (count === 0) {
        // Move all: shift-click from inventory slot
        const invSlot = bot.inventory.slots.indexOf(invItem);
        await bot.clickWindow(invSlot, 0, 1); // shift-click to move to container
      } else {
        // Use putSelectedItemRange to move specific count
        const invSlot = bot.inventory.slots.indexOf(invItem);
        // Select the item first by clicking it
        await bot.clickWindow(invSlot, 0, 0);
        await new Promise(r => setTimeout(r, 50));
        // Now put it in container
        const emptySlot = window.firstEmptySlotRange(0, window.inventoryStart);
        if (emptySlot === null) return { error: 'No empty slot in container' };
        for (let i = 0; i < count; i++) {
          await bot.clickWindow(emptySlot, 0, 0);
        }
      }
      return { success: true, placed: itemName, count: count || 'all' };
    } catch (e: any) {
      return { error: `Put failed: ${e.message}` };
    }
  },
);

registerTool(
  'execute_command',
  {
    name: 'execute_command',
    description: '执行游戏命令（如 /tp, /give, /time, /weather 等）',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令内容（不需要前缀 /）' },
      },
      required: ['command'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    let cmd = String(args.command);
    if (!cmd.startsWith('/')) cmd = '/' + cmd;
    const beforeLen = chatHistory.length;
    bot.chat(cmd);
    // Wait for server response
    await new Promise((r) => setTimeout(r, 2500));
    const responses = chatHistory.slice(beforeLen);
    return { success: true, command: cmd, responses };
  },
);

registerTool(
  'get_recipes_for',
  {
    name: 'get_recipes_for',
    description: '查询某个物品的合成配方（需要哪些材料）',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '物品名称，如 crafting_table, stone_pickaxe' },
      },
      required: ['itemName'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const itemName = String(args.itemName);
    const itemData = (bot.registry as any).itemsByName?.[itemName];
    if (!itemData) return { error: `Item "${itemName}" not found in registry` };

    const recipes = bot.recipesFor(itemData.id, null, 1, true);
    if (!recipes || recipes.length === 0) {
      return { found: false, message: `No recipe found for "${itemName}"` };
    }

    return {
      found: true,
      itemName,
      recipeCount: recipes.length,
      recipes: recipes.map((r: any) => ({
        requiresTable: !!r.requiresTable,
        output: r.output?.name || 'unknown',
        ingredients: (r.ingredients || []).map((ing: any) => ({
          name: ing?.name || 'unknown',
          count: ing?.count || 1,
          position: ing?.position || null,
        })),
      })),
    };
  },
);

registerTool(
  'get_chat_history',
  {
    name: 'get_chat_history',
    description: '获取最近的聊天/命令反馈消息列表',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
      },
    },
  },
  async (args) => {
    const limit = Math.min(Number(args.limit) || 10, 50);
    const messages = chatHistory.slice(-limit);
    return { count: messages.length, messages };
  },
);

registerTool(
  'get_surrounding_blocks',
  {
    name: 'get_surrounding_blocks',
    description: '扫描玩家周围一定范围内的非空气方块',
    inputSchema: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: '搜索半径，默认 5' },
      },
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const radius = Number(args.radius) || 5;
    const pos = bot.entity.position;
    const px = Math.floor(pos.x);
    const py = Math.floor(pos.y);
    const pz = Math.floor(pos.z);
    const blocks: any[] = [];
    const seen = new Set<string>();

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy += 2) { // step by 2 for efficiency
        for (let dz = -radius; dz <= radius; dz++) {
          const bx = px + dx;
          const by = py + dy;
          const bz = pz + dz;
          const key = `${bx},${by},${bz}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const b = bot.blockAt(new Vec3(bx, by, bz));
          if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
            blocks.push({ name: b.name, x: bx, y: by, z: bz });
          }
        }
      }
    }
    return { count: blocks.length, blocks: blocks.slice(0, 100) };
  },
);

registerTool(
  'select_hotbar_slot',
  {
    name: 'select_hotbar_slot',
    description: '选择快捷栏槽位（0=最左，8=最右）',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'number', description: '槽位号 0-8' },
      },
      required: ['slot'],
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    const slot = Number(args.slot);
    if (slot < 0 || slot > 8) return { error: 'Slot must be 0-8' };
    bot.setQuickBarSlot(slot);
    const item = bot.heldItem as any;
    return { success: true, slot, selectedItem: item ? { name: item.name, count: item.count } : null };
  },
);

registerTool(
  'activate_item',
  {
    name: 'activate_item',
    description: '使用/激活当前手持物品（右键效果，如放火把、格挡、用桶等）。也可指定方块来对方块右键。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标方块 X 坐标（可选，不填则使用手持物品）' },
        y: { type: 'number', description: '目标方块 Y 坐标' },
        z: { type: 'number', description: '目标方块 Z 坐标' },
      },
    },
  },
  async (args) => {
    if (!bot) return { error: 'Not connected' };
    if (args.x != null && args.y != null && args.z != null) {
      // Activate on a block
      const block = bot.blockAt(new Vec3(Math.floor(Number(args.x)), Math.floor(Number(args.y)), Math.floor(Number(args.z))));
      if (!block) return { error: 'No block at position' };
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('activateBlock timed out (5s)')), 5000);
          bot!.activateBlock(block).then(() => { clearTimeout(timer); resolve(); }).catch((e) => { clearTimeout(timer); reject(e); });
        });
        return { success: true, activatedBlock: block.name };
      } catch (e: any) {
        return { error: `Activate failed: ${e.message}` };
      }
    } else {
      // Activate item in hand
      bot.activateItem();
      return { success: true, activatedItem: bot.inventory.selectedItem?.name || 'unknown' };
    }
  },
);

registerTool(
  'get_held_item',
  {
    name: 'get_held_item',
    description: '获取当前手持物品信息',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const item = bot.heldItem as any;
    if (!item) return { heldItem: null };
    return {
      heldItem: {
        name: item.name,
        count: item.count,
        type: item.type,
      },
    };
  },
);

registerTool(
  'get_biome',
  {
    name: 'get_biome',
    description: '获取当前位置的生物群系',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    const pos = bot.entity.position;
    const block = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)));
    if (!block) return { biome: 'unknown' };
    const biome = (block as any)?.location?.biome;
    if (biome == null) return { biome: 'unknown', block: block.name };
    const biomeData = (bot.registry as any).biomes?.[biome];
    const biomeName = biomeData?.name || `biome_${biome}`;
    return { biome: biomeName, block: block.name };
  },
);

registerTool(
  'screenshot_2d',
  {
    name: 'screenshot_2d',
    description: '生成当前玩家周围的 2D 俯视图截图。显示地形方块颜色、实体位置（彩色点）和玩家朝向箭头。',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'number', description: '扫描半径（方块数），默认 32，最大 64' },
        size: { type: 'number', description: '输出图片边长像素，默认 1280' },
      },
    },
  },
  async (args) => {
    if (!bot || !bot.entity) return { error: 'Bot not fully connected yet' };
    const { createCanvas } = await import('canvas');

    const range = Math.min(Number(args.range) || 32, 64);
    const size = Math.min(Number(args.size) || 1280, 2048);
    const pxPerBlock = size / (range * 2);

    const px = Math.floor(bot.entity.position.x);
    const py = Math.floor(bot.entity.position.y);
    const pz = Math.floor(bot.entity.position.z);

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, size, size);

    // Block color map (common blocks)
    const blockColors: Record<string, string> = {
      grass_block: '#5d8a3c', grass_path: '#8a7242', dirt: '#8b5e3c',
      stone: '#8a8a8a', cobblestone: '#7a7a7a', bedrock: '#4a4a4a',
      oak_log: '#6b4c2a', spruce_log: '#4a3520', birch_log: '#d4c5a0',
      oak_planks: '#c4a265', spruce_planks: '#6b4a2a', birch_planks: '#d4c090',
      oak_leaves: '#3a7a2a', spruce_leaves: '#2a5a1a', birch_leaves: '#4a8a3a',
      sand: '#e8d8a0', gravel: '#7a7a7a', sandstone: '#d4c090',
      water: '#3050a8', lava: '#c04010', ice: '#a0d0f0', packed_ice: '#80b8e8',
      snow: '#f0f0f0', snow_block: '#f0f0f0', powder_snow: '#e0e8f0',
      clay: '#8aa8b8', mossy_cobblestone: '#5a7a5a',
      deepslate: '#4a4a52', cobbled_deepslate: '#5a5a62', tuff: '#5a6a5a',
      andesite: '#7a8a8a', diorite: '#b0b0b8', granite: '#a0706a',
      obsidian: '#1a0a2a', nether_bricks: '#3a1a1a', soul_sand: '#4a3a2a',
      netherrack: '#8a3030', end_stone: '#b0a870',
      brick_block: '#8a4a3a', stone_bricks: '#6a6a6a', moss_block: '#4a7a4a',
      mycelium: '#5a6a5a', soul_soil: '#5a4a3a', basalt: '#4a4a4a',
      smooth_stone: '#9a9a9a', polished_granite: '#b08078', polished_diorite: '#c0c0c8',
      polished_andesite: '#8a9a9a', quartz_block: '#f0e8e0', terracotta: '#c07a5a',
      prismarine: '#5aa8a0', dark_prismarine: '#3a6a68', sea_lantern: '#b0e0d8',
      glowstone: '#e8a030', nether_wart_block: '#8a3a5a', warped_wart_block: '#3a8a6a',
      purpur_block: '#c090c0', bone_block: '#e0dcd0',
      // ores
      coal_ore: '#6a6a6a', iron_ore: '#c0a890', copper_ore: '#a07850',
      gold_ore: '#c0a030', redstone_ore: '#8a2a2a', lapis_ore: '#3a3a8a',
      diamond_ore: '#50c0c0', emerald_ore: '#30a050',
      nether_gold_ore: '#c0a030', nether_quartz_ore: '#e0d8d0',
      ancient_debris: '#4a3a3a',
    };

    // Render blocks: scan surface (topmost non-air block per column)
    for (let dx = -range; dx < range; dx++) {
      for (let dz = -range; dz < range; dz++) {
        const bx = px + dx;
        const bz = pz + dz;
        // Scan downward from py+16 to py-32 for surface
        let blockName = 'air';
        for (let dy = 16; dy >= -32; dy--) {
          const b = bot.blockAt(new Vec3(bx, py + dy, bz));
          if (b && b.name !== 'air' && b.name !== 'cave_air') {
            blockName = b.name;
            break;
          }
        }
        const color = blockColors[blockName] || '#2a2a3a';
        const cx = (dx + range) * pxPerBlock;
        const cy = (dz + range) * pxPerBlock;
        ctx.fillStyle = color;
        ctx.fillRect(cx, cy, Math.ceil(pxPerBlock), Math.ceil(pxPerBlock));
      }
    }

    // Render entities as dots
    const entityColors: Record<string, string> = {
      zombie: '#3a8a3a', skeleton: '#c0c0c0', creeper: '#50c050',
      spider: '#4a3a3a', enderman: '#1a1a1a', villager: '#8a6a4a',
      iron_golem: '#c0c0c0', wolf: '#8a7a5a', cat: '#c08050',
      cow: '#8a6a4a', pig: '#e0a0a0', sheep: '#e0e0e0',
      chicken: '#f0f0f0', horse: '#8a5a2a', bat: '#3a3a4a',
      blaze: '#e0a030', wither_skeleton: '#4a4a5a', ghast: '#e8e8f0',
      player: '#50a0e0',
    };

    const dotRadius = Math.max(3, pxPerBlock * 1.5);
    for (const [, entity] of Object.entries(bot.entities)) {
      const ex = Math.floor(entity.position.x);
      const ez = Math.floor(entity.position.z);
      const edx = ex - px;
      const edz = ez - pz;
      if (Math.abs(edx) >= range || Math.abs(edz) >= range) continue;
      const cx = (edx + range) * pxPerBlock + pxPerBlock / 2;
      const cy = (edz + range) * pxPerBlock + pxPerBlock / 2;
      const color = (entity.name && entityColors[entity.name]) || '#ff8040';
      ctx.beginPath();
      ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Player position + facing arrow (center)
    const centerX = size / 2;
    const centerY = size / 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, dotRadius * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#3050a8';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Facing arrow
    const yawRad = (bot.entity.yaw * Math.PI) / 180;
    const arrowLen = pxPerBlock * 4;
    const ax = centerX + Math.sin(yawRad) * arrowLen;
    const ay = centerY - Math.cos(yawRad) * arrowLen;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(ax, ay);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= range * 2; i += 8) {
      const pos = i * pxPerBlock;
      ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(size, pos); ctx.stroke();
    }

    const imageData = canvas.toBuffer('image/png').toString('base64');

    return {
      __image: imageData,
      __mimeType: 'image/png',
      info: {
        player: { x: px, y: py, z: pz, yaw: Math.round(bot.entity.yaw * 10) / 10 },
        range,
        size: `${size}x${size}`,
        entities_in_view: Object.entries(bot.entities).filter(([, e]) =>
          Math.abs(Math.floor(e.position.x) - px) < range && Math.abs(Math.floor(e.position.z) - pz) < range
        ).length,
      },
    };
  },
);

// --- jump tool ---
registerTool(
  'jump',
  {
    name: 'jump',
    description: '让bot跳跃。可用于脱困、跳过障碍、或配合walk_toward走出困境。',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    if (!bot.entity) return { error: 'Bot entity not ready' };
    (bot as any).setControlState('jump', true);
    await new Promise(r => setTimeout(r, 100));
    (bot as any).setControlState('jump', false);
    await new Promise(r => setTimeout(r, 500));
    return { success: true, position: bot.entity.position, onGround: bot.entity.onGround };
  },
);

// --- stuck_check tool ---
registerTool(
  'stuck_check',
  {
    name: 'stuck_check',
    description: '诊断bot是否卡住：检查脚下方块、周围地形、是否能移动。如果卡住，自动尝试挖掉脚下方块让bot掉落。',
    inputSchema: { type: 'object', properties: {} },
  },
  async () => {
    if (!bot) return { error: 'Not connected' };
    if (!bot.entity) return { error: 'Bot entity not ready' };

    const pos = bot.entity.position;
    const px = Math.floor(pos.x), py = Math.floor(pos.y), pz = Math.floor(pos.z);
    const footY = py - 1;

    const footBlock = bot.blockAt(new Vec3(px, footY, pz));
    const belowFoot = bot.blockAt(new Vec3(px, footY - 1, pz));

    // Check if we're in a tree (leaves around)
    let leafCount = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(new Vec3(px + dx, footY, pz + dz));
        if (b && b.name.includes('leaves')) leafCount++;
      }
    }

    const inTree = leafCount > 3;
    const stuck = !bot.entity.onGround && footY > 65; // in air above ground = falling, or on a block

    // Try to dig under if stuck on leaves
    let dug = false;
    let digResult = '';
    if (inTree && footBlock && footBlock.name.includes('leaves')) {
      try {
        await safeLookAt(bot, new Vec3(px, footY, pz), true);
        await bot.dig(footBlock, true);
        dug = true;
        digResult = `Dug ${footBlock.name} at (${px}, ${footY}, ${pz})`;
        // Wait for fall
        await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        digResult = `Dig failed: ${e.message}`;
      }
    }

    const newPos = bot.entity.position;
    const fell = Math.abs(newPos.y - pos.y) > 1;

    return {
      originalPosition: { x: px, y: py, z: pz },
      currentPosition: { x: Math.floor(newPos.x), y: Math.floor(newPos.y), z: Math.floor(newPos.z) },
      onGround: bot.entity.onGround,
      footBlock: footBlock?.name || 'air',
      belowFoot: belowFoot?.name || 'air',
      inTree,
      leafCount,
      dug,
      digResult,
      fell,
      suggestion: fell
        ? 'Bot fell successfully! Check new position.'
        : (inTree
          ? 'Still stuck in tree. Try breaking more blocks below or restart MCP.'
          : 'Bot appears to be on solid ground. No action needed.'),
    };
  },
);

async function main() {
  bot = createBot();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP] Server running on stdio');
  console.error(`[Bot] Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}`);
}

main().catch((err: unknown) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
