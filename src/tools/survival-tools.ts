import { z } from "zod";
import { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { EventBuffer } from '../event-buffer.js';

interface SurvivalContext {
  getBot: () => Bot;
  getAutoFight: () => { enable(): void; disable(): void; isEnabled(): boolean } | null;
  getEventBuffer: () => EventBuffer;
}

export function registerSurvivalTools(factory: ToolFactory, ctx: SurvivalContext): void {
  const { getBot, getAutoFight, getEventBuffer } = ctx;

  // --- toggle-autofight ---
  factory.registerTool(
    "toggle-autofight",
    "Enable or disable auto-fight (kill aura + auto-eat + low-HP retreat). When enabled, the bot automatically attacks hostile mobs within 4 blocks, eats when hungry, and retreats when critically low HP.",
    {
      enable: z.boolean().describe("true to enable, false to disable"),
    },
    async ({ enable }: { enable: boolean }) => {
      const autofight = getAutoFight();
      if (!autofight) {
        return factory.createErrorResponse("AutoFight module not initialized");
      }
      if (enable) {
        autofight.enable();
        return factory.createResponse("AutoFight ENABLED: kill aura (4 block range) + auto-eat + retreat at 25% HP");
      } else {
        autofight.disable();
        return factory.createResponse("AutoFight DISABLED");
      }
    }
  );

  // --- get-scene ---
  factory.registerTool(
    "get-scene",
    "Get a compact text description of the bot's current scene: position, facing direction, nearby blocks, entities, health, food, time, biome. Use this to understand the current game state.",
    {},
    async () => {
      const bot = getBot();
      const entity = bot.entity;
      if (!entity) return factory.createErrorResponse("Bot entity not available (not spawned?)");

      const pos = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) };
      const yaw = Math.round((entity.yaw || 0) * (180 / Math.PI));
      const pitch = Math.round((entity.pitch || 0) * (180 / Math.PI));

      // Health / food
      const health = Math.round((bot.health ?? 20) * 10) / 10;
      const food = bot.food ?? 20;
      const sat = (bot as any).foodSaturationLevel ?? 0;

      // Time / biome
      const gameDay = (bot as any).time % 24000;
      const isDay = gameDay >= 0 && gameDay < 13000;
      const isNight = gameDay >= 13000 && gameDay < 23000;
      const timeStr = isDay ? 'day' : isNight ? 'night' : 'twilight';

      const biome = (bot as any).biome?.name?.replace(/minecraft:/, '') || 'unknown';

      // Surrounding blocks (lightweight: 5x3x5 cross)
      const blocks: string[] = [];
      const cx = pos.x, cy = pos.y, cz = pos.z;
      // Ground
      const ground = bot.blockAt(entity.position.clone().add(new Vec3(0, -1, 0)));
      // Above head
      const head = bot.blockAt(entity.position);
      // In front (2 blocks)
      const ahead1 = bot.blockAt(entity.position.clone().add(new Vec3(0, 0, 1)));
      const ahead2 = bot.blockAt(entity.position.clone().add(new Vec3(0, 0, 2)));
      // Left/Right (1 block)
      const left = bot.blockAt(entity.position.clone().add(new Vec3(-1, 0, 0)));
      const right = bot.blockAt(entity.position.clone().add(new Vec3(1, 0, 0)));

      const blockName = (b: Block | null | undefined) =>
        b ? b.name.replace('minecraft:', '') : 'air';

      const scene: Record<string, unknown> = {
        pos,
        facing: { yaw, pitch },
        hp: `${health}/20`,
        food: `${food}/20`,
        time: timeStr,
        biome,
        ground: blockName(ground),
        head: blockName(head),
        ahead: [blockName(ahead1), blockName(ahead2)],
        sides: { left: blockName(left), right: blockName(right) },
      };

      // Nearby entities (within 8 blocks)
      const allEntities = Object.values(bot.entities) as any[];
      const nearby = allEntities.filter(e => {
        if (e === entity) return false;
        if (!e.position) return false;
        const d = e.position.distanceTo(entity.position);
        return d < 8;
      });

      if (nearby.length > 0) {
        scene.entities = nearby.slice(0, 6).map(e => {
          const d = Math.round((e.position?.distanceTo(entity.position) || 0) * 10) / 10;
          return `${e.mobType || e.name || 'entity'} @${d}m`;
        });
      }

      // Inventory (top 5 most valuable)
      const inv = bot.inventory.items();
      if (inv.length > 0) {
        const invStr = inv.slice(0, 8).map(i => `${i.count}x ${i.name?.replace('minecraft:', '')}`).join(', ');
        scene.inventory = invStr + (inv.length > 8 ? ` (+${inv.length - 8} more)` : '');
      } else {
        scene.inventory = '(empty)';
      }

      // On ground / flying
      scene.state = entity.onGround ? 'grounded' : 'airborne';

      // Add autofight status if active
      const af = getAutoFight();
      if (af?.isEnabled()) {
        scene.autofight = 'ACTIVE';
      }

      // Add pending events summary
      const evtSummary = getEventBuffer().summarize();
      if (evtSummary) {
        scene.recentEvents = evtSummary;
      }

      return factory.createResponse(JSON.stringify(scene, null, 2));
    }
  );

  // --- get-events ---
  factory.registerTool(
    "get-events",
    "Get all game events since the last check (kills, damage taken, pickups, deaths, heals). Returns a structured summary and clears the buffer.",
    {
      urgent_only: z.boolean().optional().describe("If true, only return urgent/critical events (default: false = all)"),
    },
    async ({ urgent_only = false }: { urgent_only?: boolean }) => {
      const buffer = getEventBuffer();
      const events = buffer.drain(urgent_only);

      if (events.length === 0) {
        return factory.createResponse("No new events.");
      }

      const summary = buffer.summarize();
      const lines = events.map(e => `[${e.type}] ${e.message}`);
      return factory.createResponse(`Events (${events.length}):\n${lines.join('\n')}\n\nSummary: ${summary || 'n/a'}`);
    }
  );
}
