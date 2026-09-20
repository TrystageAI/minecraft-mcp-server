import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';

type AutoFightConfig = {
  maxDistance: number;
  attackIntervalMs: number;
  targetKinds: string[];
};

const defaultConfig: AutoFightConfig = {
  maxDistance: 16,
  attackIntervalMs: 500,
  targetKinds: ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime'],
};

let isRunning = false;
let lastAttack = 0;
let currentTarget: Entity | null = null;
let kills = 0;

function findNearestTarget(bot: Bot, config: AutoFightConfig): Entity | null {
  let nearest: Entity | null = null;
  let nearestDist = Infinity;

  for (const [id, entity] of Object.entries(bot.entities)) {
    if (Number(id) === bot.entity?.id) continue;
    if (!entity.name || !config.targetKinds.includes(entity.name)) continue;
    if (!entity.position) continue;

    const dist = entity.position.distanceTo(bot.entity.position);
    if (dist <= config.maxDistance && dist < nearestDist) {
      nearest = entity;
      nearestDist = dist;
    }
  }
  return nearest;
}

export function startAutoFight(bot: Bot, config: Partial<AutoFightConfig> = {}): void {
  const cfg = { ...defaultConfig, ...config };

  if (isRunning) {
    stopAutoFight();
  }

  isRunning = true;
  kills = 0;
  lastAttack = 0;
  currentTarget = null;

  console.log('[AutoFight] Started. Targets:', cfg.targetKinds.join(', '));

  const interval = setInterval(async () => {
    if (!isRunning || !bot.entity) return;

    if (bot.health <= 0) {
      console.log('[AutoFight] Bot died, stopping');
      stopAutoFight();
      return;
    }

    // Find target
    const target = findNearestTarget(bot, cfg);
    currentTarget = target;

    if (!target) return;

    const now = Date.now();
    if (now - lastAttack < cfg.attackIntervalMs) return;

    try {
      // Look at target
      const lookPos = target.position.clone().add(new Vec3(0, 0.5, 0));
      await bot.lookAt(lookPos, true);

      // Move close if too far
      const dist = target.position.distanceTo(bot.entity.position);
      if (dist > 4) {
        bot.lookAt(lookPos, true);
        // Simple approach: just keep attacking in range
      }

      // Attack
      if (dist <= 4) {
        await bot.attack(target);
        lastAttack = now;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AutoFight] Attack error:', msg);
    }
  }, cfg.attackIntervalMs);

  // Track kills
  bot.on('entityHurt', (entity: Entity, _source: Entity) => {
    if (entity === currentTarget) {
      // Target took damage from us
    }
  });

  bot.on('entityDead', (entity: Entity) => {
    if (entity === currentTarget) {
      kills++;
      console.log(`[AutoFight] Killed ${entity.name} (total: ${kills})`);
      currentTarget = null;
    }
  });
}

export function stopAutoFight(): void {
  if (isRunning) {
    isRunning = false;
    currentTarget = null;
    console.log('[AutoFight] Stopped. Total kills:', kills);
  }
}

export function getAutoFightStatus(): Record<string, unknown> {
  return {
    isRunning,
    currentTarget: currentTarget ? currentTarget.name : null,
    kills,
  };
}
