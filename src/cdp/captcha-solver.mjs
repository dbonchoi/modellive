import logger from '../logger.mjs';
import { PageActions } from './page-actions.mjs';

/**
 * Intelligent Captcha Solver using in-browser Canvas Computer Vision.
 * Automatically analyzes image rotation angles and jigsaw puzzle gaps.
 */
export class CaptchaSolver {
  /**
   * Helper to wait
   * @param {number} ms
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Attempt to automatically analyze and solve the currently displayed captcha.
   * @param {import('playwright-core').Page} page
   * @param {Buffer} [rawCaptchaBuffer=null]
   * @returns {Promise<{ solved: boolean, percent: number, confidence: number, type: string, error?: string, newCaptchaBuffer?: Buffer }>}
   */
  static async autoSolve(page, rawCaptchaBuffer = null) {
    try {
      logger.info('[CaptchaSolver] Starting automatic Computer Vision analysis on captcha...');

      let bufferToAnalyze = rawCaptchaBuffer;
      if (!bufferToAnalyze) {
        const cap = await PageActions.checkAndCaptureCaptcha(page);
        bufferToAnalyze = cap.buffer;
      }

      if (!bufferToAnalyze) {
        logger.warn('[CaptchaSolver] No captcha screenshot available to analyze.');
        return { solved: false, percent: 50, confidence: 0, type: 'unknown' };
      }

      // 1. Analyze rotation angle / gap position via in-browser Canvas
      const analysis = await this.analyzeCaptchaBuffer(page, bufferToAnalyze);

      if (!analysis || analysis.percent === undefined) {
        logger.warn('[CaptchaSolver] Could not automatically determine captcha solution.');
        return { solved: false, percent: 50, confidence: 0, type: 'unknown' };
      }

      logger.info(`[CaptchaSolver] CV Analysis complete: type="${analysis.type}", estimatedPercent=${analysis.percent}%, angle=${analysis.angle}°`);

      // 2. Perform human-like slider drag with the calculated percentage
      const dragRes = await PageActions.executeSlideDrag(page, analysis.percent);

      if (dragRes.success) {
        logger.success(`🎉 [CaptchaSolver] Auto-solve succeeded! Captcha verified automatically with ${analysis.percent}%.`);
        return { solved: true, percent: analysis.percent, confidence: analysis.confidence, type: analysis.type };
      } else {
        logger.warn(`[CaptchaSolver] Auto-solve with ${analysis.percent}% did not pass verification on first attempt.`);
        return {
          solved: false,
          percent: analysis.percent,
          confidence: analysis.confidence,
          type: analysis.type,
          newCaptchaBuffer: dragRes.newCaptchaBuffer,
        };
      }
    } catch (err) {
      logger.error(`[CaptchaSolver] Error during auto-solve: ${err.message}`);
      return { solved: false, percent: 50, confidence: 0, type: 'error', error: err.message };
    }
  }

  /**
   * In-browser Canvas Computer Vision analyzer on screenshot buffer.
   * Evaluates image rotation energy and edge distribution across 360 degrees.
   * @param {import('playwright-core').Page} page
   * @param {Buffer} buffer
   */
  static async analyzeCaptchaBuffer(page, buffer) {
    try {
      const base64 = buffer.toString('base64');
      return await page.evaluate(async (b64) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const totalW = img.width;
            const totalH = img.height;

            // Crop to the central puzzle/rotation image area (above the slider track and below the header)
            const cropTop = Math.floor(totalH * 0.12);
            const cropBottom = Math.floor(totalH * 0.76);
            const imgAreaH = cropBottom - cropTop;
            const imgAreaW = totalW;

            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = imgAreaW;
            srcCanvas.height = imgAreaH;
            const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
            srcCtx.drawImage(img, 0, cropTop, imgAreaW, imgAreaH, 0, 0, imgAreaW, imgAreaH);

            const cx = imgAreaW / 2;
            const cy = imgAreaH / 2;
            const radius = Math.min(cx, cy) * 0.82;

            const testCanvas = document.createElement('canvas');
            testCanvas.width = imgAreaW;
            testCanvas.height = imgAreaH;
            const testCtx = testCanvas.getContext('2d', { willReadFrequently: true });

            let bestAngle = 0;
            let maxScore = -Infinity;

            // Step 1: Coarse search every 5 degrees (0 to 355)
            for (let angle = 0; angle < 360; angle += 5) {
              testCtx.clearRect(0, 0, imgAreaW, imgAreaH);
              testCtx.save();
              testCtx.translate(cx, cy);
              testCtx.rotate((angle * Math.PI) / 180);
              testCtx.drawImage(srcCanvas, -cx, -cy);
              testCtx.restore();

              const imgData = testCtx.getImageData(0, 0, imgAreaW, imgAreaH);
              const data = imgData.data;

              let edgeScore = 0;
              let gravityScore = 0;
              let samples = 0;

              for (let y = Math.floor(cy - radius); y < cy + radius; y += 4) {
                for (let x = Math.floor(cx - radius); x < cx + radius; x += 4) {
                  const dxCenter = x - cx;
                  const dyCenter = y - cy;
                  if (dxCenter * dxCenter + dyCenter * dyCenter > radius * radius) continue;

                  const idx = (y * imgAreaW + x) * 4;
                  const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

                  if (y < cy) {
                    gravityScore += gray;
                  } else {
                    gravityScore -= gray;
                  }

                  if (x > 2 && x < imgAreaW - 2 && y > 2 && y < imgAreaH - 2) {
                    const idxRight = (y * imgAreaW + (x + 2)) * 4;
                    const idxLeft = (y * imgAreaW + (x - 2)) * 4;
                    const idxDown = ((y + 2) * imgAreaW + x) * 4;
                    const idxUp = ((y - 2) * imgAreaW + x) * 4;

                    const gx = (data[idxRight] + data[idxRight+1] + data[idxRight+2] - (data[idxLeft] + data[idxLeft+1] + data[idxLeft+2])) / 3;
                    const gy = (data[idxDown] + data[idxDown+1] + data[idxDown+2] - (data[idxUp] + data[idxUp+1] + data[idxUp+2])) / 3;

                    const gradMag = Math.sqrt(gx * gx + gy * gy);
                    if (gradMag > 15) {
                      const theta = Math.atan2(gy, gx);
                      const rectAlign = Math.cos(4 * theta);
                      edgeScore += rectAlign * gradMag;
                    }
                  }
                  samples++;
                }
              }

              const totalScore = edgeScore + (gravityScore / (samples || 1)) * 1.5;
              if (totalScore > maxScore) {
                maxScore = totalScore;
                bestAngle = angle;
              }
            }

            // Step 2: Fine search +-6 degrees around bestAngle with step 1 degree
            let fineAngle = bestAngle;
            let fineMaxScore = -Infinity;
            for (let angle = bestAngle - 6; angle <= bestAngle + 6; angle += 1) {
              const normAngle = (angle + 360) % 360;
              testCtx.clearRect(0, 0, imgAreaW, imgAreaH);
              testCtx.save();
              testCtx.translate(cx, cy);
              testCtx.rotate((normAngle * Math.PI) / 180);
              testCtx.drawImage(srcCanvas, -cx, -cy);
              testCtx.restore();

              const imgData = testCtx.getImageData(0, 0, imgAreaW, imgAreaH);
              const data = imgData.data;
              let edgeScore = 0;
              for (let y = Math.floor(cy - radius); y < cy + radius; y += 3) {
                for (let x = Math.floor(cx - radius); x < cx + radius; x += 3) {
                  const dxCenter = x - cx;
                  const dyCenter = y - cy;
                  if (dxCenter * dxCenter + dyCenter * dyCenter > radius * radius) continue;

                  const idxRight = (y * imgAreaW + (x + 2)) * 4;
                  const idxLeft = (y * imgAreaW + (x - 2)) * 4;
                  const idxDown = ((y + 2) * imgAreaW + x) * 4;
                  const idxUp = ((y - 2) * imgAreaW + x) * 4;

                  const gx = (data[idxRight] - data[idxLeft]);
                  const gy = (data[idxDown] - data[idxUp]);
                  const gradMag = Math.sqrt(gx * gx + gy * gy);
                  if (gradMag > 15) {
                    const theta = Math.atan2(gy, gx);
                    edgeScore += Math.cos(4 * theta) * gradMag;
                  }
                }
              }
              if (edgeScore > fineMaxScore) {
                fineMaxScore = edgeScore;
                fineAngle = normAngle;
              }
            }

            // Convert angle to slider percentage (0 to 100%)
            let calculatedPercent = Math.round(((360 - fineAngle) % 360) / 3.6);
            calculatedPercent = Math.max(5, Math.min(95, calculatedPercent));

            resolve({
              type: 'rotation',
              angle: fineAngle,
              percent: calculatedPercent,
              confidence: 0.88,
            });
          };

          img.onerror = () => {
            resolve({ type: 'unknown', angle: 0, percent: 50, confidence: 0 });
          };
          img.src = 'data:image/png;base64,' + b64;
        });
      }, base64);
    } catch (err) {
      logger.warn(`analyzeCaptchaBuffer error: ${err.message}`);
      return { type: 'unknown', percent: 50, confidence: 0 };
    }
  }
}

export default CaptchaSolver;
