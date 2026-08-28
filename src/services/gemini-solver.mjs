import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import logger from '../logger.mjs';

/**
 * Agy / Gemini 3.7 Flash High-Reasoning Captcha Solver Service.
 */
export class GeminiSolver {
  /**
   * @param {object} config
   * @param {string} [config.model='gemini-3.7-flash']
   * @param {string} [config.effort='high']
   * @param {string} [config.proxy='http://192.168.0.110:31028']
   * @param {number} [config.timeoutMs=180000]
   */
  constructor(config = {}) {
    this.model = config.model || 'gemini-3.7-flash';
    this.effort = config.effort || 'high';
    this.proxy = config.proxy || 'http://192.168.0.110:31028';
    this.timeoutMs = config.timeoutMs || 180000;
  }

  /**
   * Analyze captcha image buffer using agy CLI with Gemini 3.7 Flash high reasoning.
   * @param {Buffer} imageBuffer
   * @returns {Promise<{ success: boolean, percent?: number, type?: string, description?: string, confidence?: number, error?: string }>}
   */
  async solve(imageBuffer) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      return { success: false, error: 'Invalid captcha image buffer.' };
    }

    // 1. Write the latest captcha image to a temporary file
    const tempImgPath = path.resolve(process.cwd(), '.captcha_latest.png');
    try {
      fs.writeFileSync(tempImgPath, imageBuffer);
    } catch (err) {
      return { success: false, error: `Failed to save temporary captcha image: ${err.message}` };
    }

    const prompt = `Please view the image file at ${tempImgPath} using view_file. Analyze this 2D graphic puzzle artwork: locate the cutout silhouette / matching destination for the small misplaced object piece shown at the bottom-left. Calculate the horizontal position percentage (0.0 to 100.0) from the left edge of the main picture to the center of the matching slot. Return ONLY a valid JSON object with keys: type, percent, target_description, confidence.`;

    const args = [
      '-p',
      prompt,
      '--model',
      this.model,
      '--effort',
      this.effort,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ];

    const env = {
      ...process.env,
      HTTP_PROXY: this.proxy,
      HTTPS_PROXY: this.proxy,
      http_proxy: this.proxy,
      https_proxy: this.proxy,
    };

    logger.info(`[AgySolver] Launching agy CLI (Model: ${this.model}, Effort: ${this.effort}, Proxy: ${this.proxy})...`);

    const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy';
    return new Promise((resolve) => {
      execFile(exeName, args, { env, timeout: this.timeoutMs }, (error, stdout, stderr) => {
        // Clean up temporary image
        try { fs.unlinkSync(tempImgPath); } catch {}

        if (error) {
          logger.warn(`[AgySolver] agy execution failed: ${error.message}`);
          return resolve({ success: false, error: error.message });
        }

        try {
          const cliResult = JSON.parse(stdout || '{}');
          const responseText = cliResult.response || '';

          if (!responseText) {
            return resolve({ success: false, error: 'Empty response from agy agent.' });
          }

          // Extract embedded JSON from markdown or raw text
          const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
          const jsonText = match[1] || responseText;
          const parsed = JSON.parse(jsonText.trim());

          const percent = Number(parsed.percent ?? parsed.target_percent ?? parsed.percentage);
          if (isNaN(percent) || percent < 0 || percent > 100) {
            return resolve({ success: false, error: `Invalid percentage parsed: ${parsed.percent}` });
          }

          const result = {
            success: true,
            percent: Math.max(0, Math.min(100, percent)),
            type: parsed.type || 'jigsaw',
            description: parsed.target_description || parsed.description || 'Target notch detected',
            confidence: Number(parsed.confidence) || 0.95,
          };

          logger.success(`[AgySolver] Visual Recognition Succeeded! ${result.description} -> Target: ${result.percent.toFixed(2)}% (Confidence: ${result.confidence})`);
          resolve(result);
        } catch (err) {
          logger.warn(`[AgySolver] JSON parse error from agy response: ${err.message}. Raw output: ${stdout}`);
          resolve({ success: false, error: `JSON parse error: ${err.message}` });
        }
      });
    });
  }
}

export default GeminiSolver;
