import { createBot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

const bot = createBot({
  host: '192.168.31.72',
  port: 25565,
  username: 'FluxScreenshot',
  auth: 'offline',
});

bot.once('spawn', async () => {
  console.log(`[OK] Spawned at (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`);
  
  const range = 32;
  const size = 1280;
  const pxPerBlock = size / (range * 2);

  const px = Math.floor(bot.entity.position.x);
  const py = Math.floor(bot.entity.position.y);
  const pz = Math.floor(bot.entity.position.z);

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);

  const blockColors = {
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
    coal_ore: '#6a6a6a', iron_ore: '#c0a890', copper_ore: '#a07850',
    gold_ore: '#c0a030', redstone_ore: '#8a2a2a', lapis_ore: '#3a3a8a',
    diamond_ore: '#50c0c0', emerald_ore: '#30a050',
    nether_gold_ore: '#c0a030', nether_quartz_ore: '#e0d8d0',
    ancient_debris: '#4a3a3a',
  };

  // Render blocks
  let blockCount = 0;
  for (let dx = -range; dx < range; dx++) {
    for (let dz = -range; dz < range; dz++) {
      const bx = px + dx;
      const bz = pz + dz;
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
      blockCount++;
    }
  }
  console.log(`[OK] Rendered ${blockCount} blocks`);

  // Render entities
  const entityColors = {
    zombie: '#3a8a3a', skeleton: '#c0c0c0', creeper: '#50c050',
    spider: '#4a3a3a', enderman: '#1a1a1a', villager: '#8a6a4a',
    iron_golem: '#c0c0c0', wolf: '#8a7a5a', cat: '#c08050',
    cow: '#8a6a4a', pig: '#e0a0a0', sheep: '#e0e0e0',
    chicken: '#f0f0f0', horse: '#8a5a2a', bat: '#3a3a4a',
    blaze: '#e0a030', wither_skeleton: '#4a4a5a', ghast: '#e8e8f0',
    player: '#50a0e0',
  };

  const dotRadius = Math.max(3, pxPerBlock * 1.5);
  let entityCount = 0;
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
    entityCount++;
  }
  console.log(`[OK] Rendered ${entityCount} entities`);

  // Player center marker
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

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= range * 2; i += 8) {
    const pos = i * pxPerBlock;
    ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(size, pos); ctx.stroke();
  }

  const buf = canvas.toBuffer('image/png');
  writeFileSync('/tmp/mc_screenshot_2d.png', buf);
  console.log(`[DONE] Saved /tmp/mc_screenshot_2d.png (${buf.length} bytes)`);
  
  bot.quit();
  process.exit(0);
});

bot.once('error', (err) => {
  console.error('[ERR]', err.message);
  process.exit(1);
});

bot.once('kicked', (reason) => {
  console.error('[KICKED]', JSON.stringify(reason));
  process.exit(1);
});

setTimeout(() => {
  console.error('[TIMEOUT] 30s');
  process.exit(1);
}, 30000);
