import * as lark from '@larksuiteoapi/node-sdk';
import logger from '../logger.mjs';
import { CardTemplates } from './card-templates.mjs';

/**
 * Feishu Notification Service
 */
export class FeishuNotifier {
  constructor(config = {}) {
    this.config = config;
    this.client = null;
    this.enabled = Boolean(config.feishu?.enabled && config.feishu?.appId && config.feishu?.appSecret);

    if (this.enabled) {
      try {
        this.client = new lark.Client({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          appType: lark.AppType.SelfBuild,
          domain: lark.Domain.Feishu,
        });
        logger.feishu(`Feishu client initialized with App ID: ${config.feishu.appId}`);
      } catch (err) {
        logger.error(`Failed to initialize Feishu client: ${err.message}`);
        this.enabled = false;
      }
    }
  }

  /**
   * Upload an image buffer to Feishu and get image_key.
   * @param {Buffer} buffer
   * @returns {Promise<string | null>}
   */
  async uploadImage(buffer) {
    if (!this.enabled || !this.client) return null;
    try {
      logger.feishu('Uploading image to Feishu...');
      const res = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: buffer,
        },
      });

      if (res && res.image_key) {
        logger.feishu(`Image uploaded successfully: ${res.image_key}`);
        return res.image_key;
      }
      return null;
    } catch (err) {
      logger.error(`Failed to upload image to Feishu: ${err.message}`);
      return null;
    }
  }

  /**
   * Send an interactive card message to users or chat.
   * @param {object} card
   * @param {string} [receiveId]
   * @param {'open_id' | 'user_id' | 'chat_id'} [receiveIdType='open_id']
   */
  async sendCard(card, receiveId = null, receiveIdType = 'open_id') {
    if (!this.enabled || !this.client) {
      return false;
    }

    const targetUsers = receiveId
      ? [receiveId]
      : (this.config.feishu?.adminUserIds || []);

    if (targetUsers.length === 0) {
      logger.warn('No adminUserIds configured for Feishu notifications.');
      return false;
    }

    let allSent = true;
    for (const uid of targetUsers) {
      try {
        const idType = uid.startsWith('oc_') ? 'chat_id' : (uid.startsWith('ou_') ? 'open_id' : receiveIdType);
        await this.client.im.v1.message.create({
          params: { receive_id_type: idType },
          data: {
            receive_id: uid,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        });
        logger.feishu(`Message card sent to ${uid}`);
      } catch (err) {
        logger.error(`Failed to send card to ${uid}: ${err.message}`);
        allSent = false;
      }
    }

    return allSent;
  }

  /**
   * Send alert message.
   */
  async sendAlert(title, message, details = '') {
    if (!this.config.feishu?.notifyOnFailure) return;
    const card = CardTemplates.buildAlertCard(title, message, details);
    return await this.sendCard(card);
  }

  /**
   * Send status summary card.
   */
  async sendStatus(summary, receiveId = null) {
    const card = CardTemplates.buildStatusCard(summary);
    return await this.sendCard(card, receiveId);
  }

  /**
   * Send QR code login card with uploaded image buffer.
   */
  async sendLoginQRCode(imageBuffer, receiveId = null) {
    const imageKey = await this.uploadImage(imageBuffer);
    if (!imageKey) {
      return await this.sendAlert('登录二维码获取失败', '未能将登录二维码上传至飞书，请在本地电脑屏幕中完成登录。');
    }

    const card = CardTemplates.buildLoginQrCard(imageKey);
    return await this.sendCard(card, receiveId);
  }
}

export default FeishuNotifier;
