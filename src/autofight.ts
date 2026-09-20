/**
 * Auto-fight module: kill aura + auto-eat + low-HP retreat.
 * Runs as a background loop, independent of LLM turn cycle.
 */
import mineflayer from 'mineflayer';
import { EventBuffer } from './event-buffer.js';

interface AutoFightConfig {
  /** Range to attack entities (blocks) */
  attackRange: number;
  /** Minimum HP% below which auto-eat triggers */
  eatThreshold: number;
  /** HP% below which bot retreats (stops pathfinding, sprints back) */
  retreatThreshold: number;
  /** Attack cooldown in ms (anti-cheat friendly) */
  attackCooldownMs: number;
}

const DEFAULT_CONFIG: AutoFightConfig = {
  attackRange: 4,
  eatThreshold: 0.5,
  retreatThreshold: 0.25,
  attackCooldownMs: 400,
};

export class AutoFight {
  private bot: mineflayer.Bot;
  private buffer: EventBuffer;
  private config: AutoFightConfig;
  private enabled = false;
  private lastAttackTime = 0;
  private currentTarget: mineflayer.Entity | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private retreatMode = false;

  constructor(bot: mineflayer.Bot, buffer: EventBuffer, config?: Partial<AutoFightConfig>) {
    this.bot = bot;
    this.buffer = buffer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.retreatMode = false;
    this.lastAttackTime = 0;
    this.currentTarget = null;

    this.intervalId = setInterval(() => this.tick(), 50);
    this.buffer.push('info', 'autofight ENABLED', false);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.retreatMode = false;
    this.currentTarget = null;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.bot.setControlState('sprint', false);
    this.buffer.push('info', 'autofight DISABLED', false);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private tick(): void {
    if (!this.enabled || !this.bot.entity) return;

    const health = this.bot.health ?? 20;
    const maxHealth = this.bot.maxHealth ?? 20;
    const healthPct = health / maxHealth;

    // Priority 1: Retreat if critically low HP
    if (healthPct <= this.config.retreatThreshold && !this.retreatMode) {
      this.enterRetreat();
    }

    // Priority 2: Auto-eat
    this.checkAutoEat(healthPct);

    // Priority 3: Kill aura (skip if retreating)
    if (!this.retreatMode) {
      this.tickKillAura();
    }
  }

  private tickKillAura(): void {
    const now = Date.now();
    if (now - this.lastAttackTime < this.config.attackCooldownMs) return;

    // Find nearest hostile in range
    const target = this.findNearestHostile();
    if (!target) {
      this.currentTarget = null;
      return;
    }

    this.currentTarget = target;

    // Face the target
    const targetPos = target.entity.position;
    if (targetPos) {
      this.bot.lookAt(targetPos);
    }

    // Attack
    this.bot.attack(target);
    this.lastAttackTime = now;
    this.buffer.push('kill', target.name || target.mobType || 'unknown', false);
  }

  private findNearestHostile(): mineflayer.Entity | null {
    const pos = this.bot.entity?.position;
    if (!pos) return null;

    const entities = this.bot.nearestEntities();
    let best: mineflayer.Entity | null = null;
    let bestDist = this.config.attackRange;

    for (const entity of entities) {
      if (entity === this.bot.entity) continue;
      const pos2 = entity.position;
      if (!pos2) continue;

      // Only attack hostile mobs
      if (!this.isHostile(entity)) continue;

      const dist = pos.distanceTo(pos2);
      if (dist < bestDist) {
        bestDist = dist;
        best = entity;
      }
    }

    return best;
  }

  private isHostile(entity: mineflayer.Entity): boolean {
    const type = entity.mobType?.toLowerCase() || entity.name?.toLowerCase() || '';
    const hostileList = [
      'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
      'husk', 'stray', 'drowned', 'slime', 'blaze', 'ghast',
      'magma', 'wither', 'phantom', 'silverfish', 'cave_spider',
      'zombie_villager', 'zombie_horse', 'skeleton_horse',
      'piglin', 'hoglin', 'zoglin', 'piglin_brute',
    ];
    return hostileList.some(h => type.includes(h));
  }

  private checkAutoEat(healthPct: number): void {
    if (healthPct >= this.config.eatThreshold) return;

    const food = this.bot.foodLevel ?? 20;
    if (food <= 10) return; // Don't eat if we have little food

    // Find best food item
    const foodItems = this.bot.inventory.items().filter(item => {
      const name = item.name?.toLowerCase() || '';
      return [
        'golden_apple', 'cooked_beef', 'cooked_porkchop', 'baked_potato',
        'cooked_chicken', 'bread', 'apple', 'pumpkin_pie',
        'golden_carrot', 'beef', 'porkchop', 'mutton', 'carrot', 'potato'
      ].some(f => name.includes(f));
    });

    if (foodItems.length === 0) return;

    // Prioritize best food
    const priority = ['golden_apple', 'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'pumpkin_pie'];
    let bestItem = foodItems[0];
    for (const p of priority) {
      const found = foodItems.find(i => i.name?.toLowerCase().includes(p));
      if (found) {
        bestItem = found;
        break;
      }
    }

    this.bot.equip(bestItem, 'hand');
    this.bot.setControlState('forward', false); // Stop moving while eating
    this.bot.consume();
    this.buffer.push('heal', `ate ${bestItem.name}`, false);
  }

  private enterRetreat(): void {
    this.retreatMode = true;
    this.currentTarget = null;
    this.buffer.push('info', 'RETREAT: low HP, stopping attacks', true);

    // Sprint to try to escape
    this.bot.setControlState('sprint', true);

    // Try to find a safe direction (away from nearest enemy)
    const nearest = this.bot.nearestEntity(e => e.position && this.isHostile(e));
    if (nearest?.position) {
      const pos = this.bot.entity?.position;
      if (pos) {
        const awayVec = pos.minus(nearest.position).norm();
        // Face away from threat
        const yaw = Math.atan2(-awayVec.x, -awayVec.z);
        this.bot.lookAt(pos.plus(awayVec), true);
      }
    }
  }

  /** Called externally when HP recovers above retreat threshold */
  checkRetreatRecovery(): void {
    if (!this.retreatMode) return;
    const health = this.bot.health ?? 20;
    const maxHealth = this.bot.maxHealth ?? 20;
    if (health / maxHealth > this.config.retreatThreshold + 0.1) {
      this.retreatMode = false;
      this.bot.setControlState('sprint', false);
      this.buffer.push('info', 'Retreat over: HP recovered', false);
    }
  }

  destroy(): void {
    this.disable();
  }
}
