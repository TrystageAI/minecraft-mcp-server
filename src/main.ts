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
    const goal = new goals.GoalNear(x, y, z, 2);
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
