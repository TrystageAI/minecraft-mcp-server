#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { EventBuffer } from './event-buffer.js';
import { AutoFight } from './autofight.js';
import { registerPositionTools } from './tools/position-tools.js';
import { registerInventoryTools } from './tools/inventory-tools.js';
import { registerBlockTools } from './tools/block-tools.js';
import { registerEntityTools } from './tools/entity-tools.js';
import { registerChatTools } from './tools/chat-tools.js';
import { registerFlightTools } from './tools/flight-tools.js';
import { registerGameStateTools } from './tools/gamestate-tools.js';
import { registerCraftingTools } from './tools/crafting-tools.js';
import { registerFurnaceTools } from './tools/furnace-tools.js';
import { registerSurvivalTools } from './tools/survival-tools.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();
  const eventBuffer = new EventBuffer();
  let autofight: AutoFight | null = null;

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  connection.connect();

  // Wire up event buffer hooks on the bot
  const bot = connection.getBot()!;
  if (bot) {
    bot.on('health', () => {
      autofight?.checkRetreatRecovery();
    });
    bot.on('death', () => {
      eventBuffer.push('death', 'Bot died!', true);
    });
    bot.on('itemDrop', (_entity, droppedItem) => {
      // itemDrop fires when we lose an item on death
      eventBuffer.push('info', `dropped ${droppedItem.name}`, false);
    });
    bot.on('collect', (item, collector) => {
      if (collector === bot) {
        eventBuffer.push('pickup', `pickup: ${item.name}`, false);
      }
    });
    bot.on('hit', (_entity, _damage) => {
      eventBuffer.push('damage', 'took damage', true);
    });
    bot.on('hurt', (damage, _cause) => {
      eventBuffer.push('damage', `-${damage} HP`, damage > 4);
    });
    bot.on('spawn', () => {
      autofight = new AutoFight(bot, eventBuffer);
      log('info', 'AutoFight module initialized');
    });
  }

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;

  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerSurvivalTools(factory, {
    getBot,
    getAutoFight: () => autofight,
    getEventBuffer: () => eventBuffer,
  });

  process.stdin.on('end', () => {
    autofight?.destroy();
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
