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
    return {
      position: bot.entity.position,
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
    await bot.lookAt(new Vec3(x, y, z), true);
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
    await bot.lookAt(entity.position, true);
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
    const item = (bot.inventory as any).findSlot(
      (i: Item) => i.name === itemName && i.slot !== 40 && i.slot !== 45,
      -1,
    );
    if (!item) return { success: false, reason: 'Item not found' };
    await bot.equip(item, 'hand');
    return { success: true, equipped: itemName };
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

    // Look at target
    await bot.lookAt(new Vec3(x, y, z), false);

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
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    const blockPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = bot.blockAt(blockPos);
    if (!block || block.name === 'air') {
      return { success: false, reason: 'No block at position or already air' };
    }
    const originalBlockName = block.name;

    // Look at the block center
    await bot.lookAt(blockPos, true);

    // Start mining
    try {
      await bot.dig(block, true);
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
    const result = await tool.handler(params.arguments || {});
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

  return b;
}

registerTool(
  'place_block',
  {
    name: 'place_block',
    description: '在指定位置放置当前手持方块。会自动寻找相邻方块作为参考面。',
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
    const x = Math.floor(Number(args.x));
    const y = Math.floor(Number(args.y));
    const z = Math.floor(Number(args.z));

    // Check target is air
    const target = bot.blockAt(new Vec3(x, y, z));
    if (target && target.name !== 'air' && target.name !== 'cave_air' && target.name !== 'void_air') {
      return { error: `Target position is not air (it's ${target.name})` };
    }

    // Find adjacent solid block and determine face
    const dirs = [
      { dx: -1, dy: 0, dz: 0, face: new Vec3(1, 0, 0) },
      { dx: 1, dy: 0, dz: 0, face: new Vec3(-1, 0, 0) },
      { dx: 0, dy: -1, dz: 0, face: new Vec3(0, 1, 0) },
      { dx: 0, dy: 1, dz: 0, face: new Vec3(0, -1, 0) },
      { dx: 0, dy: 0, dz: -1, face: new Vec3(0, 0, 1) },
      { dx: 0, dy: 0, dz: 1, face: new Vec3(0, 0, -1) },
    ];

    for (const dir of dirs) {
      const neighbor = bot.blockAt(new Vec3(x + dir.dx, y + dir.dy, z + dir.dz));
      if (neighbor && neighbor.name !== 'air' && neighbor.name !== 'cave_air' && neighbor.name !== 'void_air') {
        try {
          await bot.placeBlock(neighbor, dir.face);
          return { success: true, placedAt: { x, y, z }, referenceBlock: neighbor.name };
        } catch (e: any) {
          return { error: `Failed to place: ${e.message}` };
        }
      }
    }
    return { error: 'No adjacent solid block found to place against' };
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
    bot.chat(cmd);
    return { success: true, command: cmd };
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
    const item = bot.inventory.selectedItem;
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
        await bot.activateBlock(block);
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
    const item = bot.inventory.selectedItem;
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
