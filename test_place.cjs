const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const bot = mineflayer.createBot({
  host: '192.168.31.72',
  port: 25565,
  username: 'FluxDebug3'
});

bot.once('error', (e) => { console.log('ERROR:', e.message); process.exit(1); });

bot.once('spawn', () => {
  console.log('Spawned at:', bot.entity.position);
  
  // TP to the same location as the main bot
  bot.chat('/tp FluxDebug3 138 64 -796');
  
  setTimeout(() => {
    console.log('Position after tp:', bot.entity.position);
    
    // Check nearby blocks
    const pos = bot.entity.position.floored();
    console.log('Block at feet:', bot.blockAt(pos)?.name);
    console.log('Block below:', bot.blockAt(pos.offset(0,-1,0))?.name);
    console.log('Block at z-2 (same level):', bot.blockAt(pos.offset(0,0,-2))?.name);
    console.log('Block at z+2 (same level):', bot.blockAt(pos.offset(0,0,2))?.name);
    console.log('Block above (y+1):', bot.blockAt(pos.offset(0,1,0))?.name);
    
    // Now give ourselves a crafting table and try to place it
    bot.chat('/give FluxDebug3 crafting_table');
    
    setTimeout(async () => {
      console.log('After give - held item:', bot.heldItem);
      const items = bot.inventory.items();
      console.log('Inventory:', items.map(i => i.name + ' x' + i.count).join(', '));
      
      // Select the crafting table
      const tableSlot = bot.inventory.slots.findIndex(s => s && s.name === 'crafting_table');
      console.log('Table at slot:', tableSlot);
      if (tableSlot >= 0) {
        bot.setQuickBarSlot(tableSlot);
        await new Promise(r => setTimeout(r, 500));
        console.log('Held after select:', bot.heldItem);
        
        // Try to place at z-2 (in front of us)
        const targetPos = new Vec3(138, 64, -798);
        console.log('Target for placement:', targetPos);
        const targetBlock = bot.blockAt(targetPos);
        console.log('Target block:', targetBlock?.name);
        
        // Find a reference block
        const refBlock = bot.blockAt(new Vec3(138, 64, -797));
        console.log('Reference block (z-797):', refBlock?.name);
        
        if (refBlock && refBlock.name !== 'air' && targetBlock?.name === 'air') {
          // Face vector: from ref toward target (z direction: -1 since target is more negative z)
          // ref is at z=-797, target is at z=-798, so face is in the -z direction
          const faceVector = new Vec3(0, 0, -1);
          
          console.log('Attempting placeBlock...');
          try {
            const result = await Promise.race([
              bot.placeBlock(refBlock, faceVector),
              new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 8s')), 8000))
            ]);
            console.log('SUCCESS! Placed block. Result:', result);
            
            // Verify
            await new Promise(r => setTimeout(r, 500));
            const placed = bot.blockAt(targetPos);
            console.log('Verification - block at target now:', placed?.name);
          } catch (e) {
            console.log('PLACE FAILED:', e.message);
            
            // Check if block was actually placed despite the error
            await new Promise(r => setTimeout(r, 500));
            const placed = bot.blockAt(targetPos);
            console.log('Verification - block at target now:', placed?.name);
          }
        } else {
          console.log('Could not find valid target/ref combination');
        }
        
        bot.quit();
        process.exit(0);
      } else {
        console.log('No crafting table in inventory');
        bot.quit();
        process.exit(0);
      }
    }, 3000);
  }, 2000);
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 25000);
