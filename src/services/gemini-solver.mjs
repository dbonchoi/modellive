import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFile } from 'child_process';
import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from '../logger.mjs';

/**
 * High-Speed AI Captcha Solver supporting both Direct Gemini Vision API and agy CLI Agent.
 */
export class GeminiSolver {
  /**
   * @param {object} config
   * @param {string} [config.type='auto'] - 'auto' | 'api' | 'agy'
   * @param {string} [config.apiKey]
   * @param {string} [config.model='gemini-3.5-flash-lite']
   * @param {string} [config.effort='low']
   * @param {string} [config.proxy='http://192.168.0.110:31028']
   * @param {number} [config.timeoutMs=30000]
   */
  constructor(config = {}) {
    this.type = config.type || 'auto';
    this.apiKey = config.apiKey || 'AIzaSyCYAc7H7urJt1RRrAgxCOTRjJ5vp1DsPKs';
    this.model = config.model || 'gemini-3.5-flash-lite';
    this.effort = config.effort || 'low';
    this.proxy = config.proxy || 'http://192.168.0.110:31028';
    this.timeoutMs = config.timeoutMs || 30000;
  }

  /**
   * Solve captcha image using direct API (fastest ~3s) or agy CLI agent.
   * @param {Buffer} imageBuffer
   * @returns {Promise<{ success: boolean, percent?: number, type?: string, description?: string, confidence?: number, error?: string }>}
   */
  async solve(imageBuffer) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      return { success: false, error: 'Invalid captcha image buffer.' };
    }

    // Try Direct API first if type is 'auto' or 'api'
    if (this.type === 'api' || (this.type === 'auto' && this.apiKey)) {
      try {
        const apiRes = await this.solveViaDirectApi(imageBuffer);
        if (apiRes.success) return apiRes;
        logger.warn(`[GeminiSolver] Direct API attempt did not succeed: ${apiRes.error}. Falling back to agy CLI...`);
      } catch (err) {
        logger.warn(`[GeminiSolver] Direct API error: ${err.message}. Falling back to agy CLI...`);
      }
    }

    // Use agy CLI
    return this.solveViaAgyCli(imageBuffer);
  }

  /**
   * Direct Gemini Vision API call (ultra-fast ~3 seconds).
   * @param {Buffer} imageBuffer
   * @returns {Promise<{ success: boolean, percent?: number, type?: string, description?: string, confidence?: number, error?: string }>}
   */
  async solveViaDirectApi(imageBuffer) {
    const modelsToTry = [this.model, 'gemini-3.5-flash-lite', 'gemini-3.7-flash'];
    const uniqueModels = [...new Set(modelsToTry.filter(Boolean))];

    const prompt = `You are an AI computer vision analysis assistant.
Task: Analyze this 2D graphic puzzle artwork. Locate the cutout silhouette / matching destination for the small misplaced object piece shown at the left/bottom-left.
Calculate the horizontal position percentage (0.0 to 100.0) from the left edge of the main picture to the center of the matching slot.
Return ONLY a valid JSON object with keys: type, percent, target_description, confidence.`;

    const imgB64 = imageBuffer.toString('base64');
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/png',
              data: imgB64
            }
          }
        ]
      }],
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.1
      }
    };

    const postData = Buffer.from(JSON.stringify(payload));
    const agent = this.proxy ? new HttpsProxyAgent(this.proxy) : undefined;

    for (const model of uniqueModels) {
      try {
        logger.info(`[GeminiSolver] Requesting Gemini Vision API (Model: ${model}, Proxy: ${this.proxy || 'None'})...`);
        const responseText = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
            method: 'POST',
            agent,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': postData.length,
            },
            timeout: Math.min(15000, this.timeoutMs),
          }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
          });

          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error(`API request timed out on model ${model}`));
          });

          req.write(postData);
          req.end();
        });

        const json = JSON.parse(responseText);
        if (json.error) {
          logger.warn(`[GeminiSolver] Model ${model} returned API error (${json.error.code}): ${json.error.message}`);
          continue;
        }

        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, rawText];
        const jsonText = match[1] || rawText;
        const parsed = JSON.parse(jsonText.trim());

        const percent = Number(parsed.percent ?? parsed.target_percent ?? parsed.percentage);
        if (!isNaN(percent) && percent >= 0 && percent <= 100) {
          const result = {
            success: true,
            percent: Math.max(0, Math.min(100, percent)),
            type: parsed.type || 'jigsaw',
            description: parsed.target_description || parsed.description || 'Target notch detected',
            confidence: Number(parsed.confidence) || 0.98,
          };
          logger.success(`[GeminiSolver] API Recognition Succeeded! ${result.description} -> Target: ${result.percent.toFixed(2)}% (Confidence: ${result.confidence})`);
          return result;
        }
      } catch (err) {
        logger.warn(`[GeminiSolver] Attempt on ${model} failed: ${err.message}`);
      }
    }

    return { success: false, error: 'All Direct Gemini API model attempts failed or timed out.' };
  }

  /**
   * Analyze captcha image buffer using agy CLI with Gemini.
   * @param {Buffer} imageBuffer
   * @returns {Promise<{ success: boolean, percent?: number, type?: string, description?: string, confidence?: number, error?: string }>}
   */
  async solveViaAgyCli(imageBuffer) {
    const tempImgPath = path.resolve(process.cwd(), '.captcha_latest.png');
    try {
      fs.writeFileSync(tempImgPath, imageBuffer);
    } catch (err) {
      return { success: false, error: `Failed to save temporary captcha image: ${err.message}` };
    }

    const prompt = `Please view the image file at ${tempImgPath} using view_file. Analyze this 2D graphic puzzle artwork: locate the cutout silhouette / matching destination for the small misplaced object piece shown at the left/bottom-left. Calculate the horizontal position percentage (0.0 to 100.0) from the left edge of the main picture to the center of the matching slot. Return ONLY a valid JSON object with keys: type, percent, target_description, confidence.`;

    const agyModel = (this.model && this.model.includes('3.7')) ? this.model : 'gemini-3.7-flash';
    const args = [
      '-p',
      prompt,
      '--model',
      agyModel,
      '--effort',
      this.effort || 'low',
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

    logger.info(`[AgySolver] Launching agy CLI (Model: ${agyModel}, Effort: ${this.effort || 'low'}, Proxy: ${this.proxy})...`);

    const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy';
    return new Promise((resolve) => {
      execFile(exeName, args, { env, timeout: this.timeoutMs }, (error, stdout, stderr) => {
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
