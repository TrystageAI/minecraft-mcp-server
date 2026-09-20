/**
 * Event buffer: collects game events (kills, damage, pickups) in a rolling
 * window and produces compact summaries for LLM consumption.
 */

export interface GameEvent {
  type: 'kill' | 'damage' | 'pickup' | 'heal' | 'death' | 'info';
  message: string;
  timestamp: number;
  /** true if this event should immediately surface to the LLM (critical) */
  urgent: boolean;
}

const MAX_BUFFER = 200;
const SUMMARY_WINDOW_MS = 10_000; // 10s rolling window for routine summary

export class EventBuffer {
  private buffer: GameEvent[] = [];
  private killCount = 0;
  private damageTaken = 0;
  private itemsPicked: Map<string, number> = new Map();

  push(type: GameEvent['type'], message: string, urgent = false): void {
    this.buffer.push({ type, message, timestamp: Date.now(), urgent });
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }

    // track aggregates
    if (type === 'kill') this.killCount++;
    if (type === 'damage') this.damageTaken++;
    if (type === 'pickup') {
      const key = message.replace(/^[a-z_]+: /, '');
      this.itemsPicked.set(key, (this.itemsPicked.get(key) || 0) + 1);
    }
  }

  /** Returns all events since last drain that are urgent, or all if force=true */
  drain(urgentOnly = true): GameEvent[] {
    const now = Date.now();
    const result: GameEvent[] = [];
    const remaining: GameEvent[] = [];

    for (const evt of this.buffer) {
      if (urgentOnly && !evt.urgent) {
        // keep non-urgent in buffer if within window
        if (now - evt.timestamp < SUMMARY_WINDOW_MS) {
          remaining.push(evt);
        }
        continue;
      }
      result.push(evt);
    }

    this.buffer = remaining;
    return result;
  }

  /** Returns a compact summary of events in the last window */
  summarize(): string {
    const now = Date.now();
    const recent = this.buffer.filter(e => now - e.timestamp < SUMMARY_WINDOW_MS);
    if (recent.length === 0) return '';

    const kills = recent.filter(e => e.type === 'kill');
    const damage = recent.filter(e => e.type === 'damage');
    const pickups = recent.filter(e => e.type === 'pickup');
    const deaths = recent.filter(e => e.type === 'death');
    const heals = recent.filter(e => e.type === 'heal');

    const parts: string[] = [];

    if (kills.length > 0) {
      parts.push(`killed ${kills.length} (${kills.map(k => k.message).slice(0, 5).join(', ')}${kills.length > 5 ? '...' : ''})`);
    }
    if (damage.length > 0) {
      parts.push(`took ${damage.length} hits`);
    }
    if (pickups.length > 0) {
      const picked = pickups.map(p => p.message.replace(/^pickup: /, ''));
      const unique = [...new Set(picked)];
      parts.push(`picked up: ${unique.join(', ')}`);
    }
    if (deaths.length > 0) {
      parts.push(`DIED ${deaths.length} time(s)`);
    }
    if (heals.length > 0) {
      parts.push(`healed ${heals.length}x`);
    }

    return parts.join('; ');
  }

  /** Get and reset aggregate counters since last call */
  resetAggregates(): { kills: number; damage: number; items: Map<string, number> } {
    const result = {
      kills: this.killCount,
      damage: this.damageTaken,
      items: new Map(this.itemsPicked),
    };
    this.killCount = 0;
    this.damageTaken = 0;
    this.itemsPicked.clear();
    return result;
  }

  clear(): void {
    this.buffer = [];
    this.killCount = 0;
    this.damageTaken = 0;
    this.itemsPicked.clear();
  }
}
