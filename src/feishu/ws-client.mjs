import * as lark from '@larksuiteoapi/node-sdk';
import logger from '../logger.mjs';

/**
 * Feishu WebSocket Long-Connection Client
 */
export class FeishuWSClient {
  /**
   * @param {object} config
   * @param {import('./message-handler.mjs').MessageHandler} messageHandler
   */
  constructor(config, messageHandler) {
    this.config = config;
    this.messageHandler = messageHandler;
    this.wsClient = null;
    this.isConnected = false;
  }

  /**
   * Start Feishu WebSocket client.
   */
  async start() {
    const feishuConf = this.config.feishu || {};
    if (!feishuConf.enabled || !feishuConf.appId || !feishuConf.appSecret) {
      logger.info('Feishu integration is not enabled or credentials not configured. Skipping WS connection.');
      return false;
    }

    try {
      logger.feishu(`Connecting to Feishu WebSocket gateway (App ID: ${feishuConf.appId})...`);

      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const message = data.message;
            const sender = data.sender;
            const content = JSON.parse(message.content || '{}');
            const text = content.text || '';
            const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id;
            const chatId = message.chat_id;

            logger.feishu(`Received message from ${senderId}: "${text}"`);
            await this.messageHandler.handleTextCommand(text, senderId, chatId);
          } catch (err) {
            logger.error(`Error handling Feishu message event: ${err.message}`);
          }
        },
        'card.action.trigger': async (data) => {
          try {
            const action = data.action?.value || {};
            const senderId = data.open_id;
            logger.feishu(`Received card action click from ${senderId}: ${JSON.stringify(action)}`);
            await this.messageHandler.handleCardAction(action, senderId);
            return { toast: { type: 'info', content: '指令已提交处理' } };
          } catch (err) {
            logger.error(`Error handling Feishu card action: ${err.message}`);
            return { toast: { type: 'error', content: '处理失败: ' + err.message } };
          }
        },
      });

      this.wsClient = new lark.WSClient({
        appId: feishuConf.appId,
        appSecret: feishuConf.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      await this.wsClient.start({
        eventDispatcher,
      });

      this.isConnected = true;
      logger.success('Feishu WebSocket client connected successfully. Real-time bot commands are active!');
      return true;
    } catch (err) {
      this.isConnected = false;
      logger.error(`Failed to start Feishu WebSocket client: ${err.message}`);
      return false;
    }
  }

  /**
   * Stop Feishu WebSocket client.
   */
  async stop() {
    if (this.wsClient && this.isConnected) {
      try {
        await this.wsClient.close();
      } catch {
        // ignore
      }
      this.isConnected = false;
    }
  }
}

export default FeishuWSClient;
