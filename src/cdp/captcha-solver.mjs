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
   * @returns {Promise<{ solved: boolean, percent: number, confidence: number, type: string, error?: string }>}
   */
  static async autoSolve(page) {
    try {
      logger.info('[CaptchaSolver] Starting automatic Computer Vision analysis on captcha...');

      // 1. Analyze rotation angle / gap position via Canvas
      const analysis = await this.analyzeCaptchaImage(page);

      if (!analysis || analysis.percent === undefined) {
        logger.warn('[CaptchaSolver] Could not automatically determine captcha solution.');
        return { solved: false, percent: 50, confidence: 0, type: 'unknown' };
      }

      logger.info(`[CaptchaSolver] CV Analysis complete: type="${analysis.type}", estimatedPercent=${analysis.percent}%, confidence=${analysis.confidence.toFixed(2)}`);

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
   * In-browser Canvas Computer Vision analyzer.
   * Evaluates image rotation energy and edge distribution across 360 degrees.
   * @param {import('playwright-core').Page} page
   */
  static async analyzeCaptchaImage(page) {
    try {
      return await page.evaluate(async () => {
        // 1. Locate the captcha image element
        const imgSelectors = [
          'div:has-text("请完成安全验证") img',
          '.antd5-modal-content img',
          '.nc-container img',
          'div[role="dialog"] img',
          'canvas.nc_canvas',
          'img[src*="captcha"]',
          'img[src*="baxia"]',
        ];

        let imgEl = null;
        for (const sel of imgSelectors) {
          const el = document.querySelector(sel);
          if (el && el.naturalWidth > 50) {
            imgEl = el;
            break;
          }
        }

        if (!imgEl) {
          // Check for any visible image inside dialog with reasonable size
          const allImgs = Array.from(document.querySelectorAll('img, canvas'));
          for (const img of allImgs) {
            const rect = img.getBoundingClientRect();
            if (rect.width >= 120 && rect.height >= 120 && rect.top > 0) {
              imgEl = img;
              break;
            }
          }
        }

        if (!imgEl) {
          return { type: 'unknown', percent: 50, confidence: 0 };
        }

        // 2. Draw image to offscreen canvas
        const srcCanvas = document.createElement('canvas');
        const w = imgEl.naturalWidth || imgEl.width || 280;
        const h = imgEl.naturalHeight || imgEl.height || 280;
        srcCanvas.width = w;
        srcCanvas.height = h;
        const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
        srcCtx.drawImage(imgEl, 0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(cx, cy) * 0.85;

        // 3. Multi-angle Rectilinear Gradient & Gravity Symmetry Analysis
        const testCanvas = document.createElement('canvas');
        testCanvas.width = w;
        testCanvas.height = h;
        const testCtx = testCanvas.getContext('2d', { willReadFrequently: true });

        let bestAngle = 0;
        let maxScore = -Infinity;

        // Coarse search: step 5 degrees
        for (let angle = 0; angle < 360; angle += 5) {
          testCtx.clearRect(0, 0, w, h);
          testCtx.save();
          testCtx.translate(cx, cy);
          testCtx.rotate((angle * Math.PI) / 180);
          testCtx.drawImage(srcCanvas, -cx, -cy);
          testCtx.restore();

          const imgData = testCtx.getImageData(0, 0, w, h);
          const data = imgData.data;

          let edgeScore = 0;
          let gravityScore = 0;
          let samples = 0;

          // Sample central circle
          for (let y = Math.floor(cy - radius); y < cy + radius; y += 4) {
            for (let x = Math.floor(cx - radius); x < cx + radius; x += 4) {
              const dxCenter = x - cx;
              const dyCenter = y - cy;
              if (dxCenter * dxCenter + dyCenter * dyCenter > radius * radius) continue;

              const idx = (y * w + x) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              const gray = 0.299 * r + 0.587 * g + 0.114 * b;

              // Top half vs Bottom half luminance (Sky/light on top)
              if (y < cy) {
                gravityScore += gray;
              } else {
                gravityScore -= gray;
              }

              // Sobel horizontal and vertical gradients
              if (x > 2 && x < w - 2 && y > 2 && y < h - 2) {
                const idxRight = (y * w + (x + 2)) * 4;
                const idxLeft = (y * w + (x - 2)) * 4;
                const idxDown = ((y + 2) * w + x) * 4;
                const idxUp = ((y - 2) * w + x) * 4;

                const gx = (data[idxRight] + data[idxRight+1] + data[idxRight+2] - (data[idxLeft] + data[idxLeft+1] + data[idxLeft+2])) / 3;
                const gy = (data[idxDown] + data[idxDown+1] + data[idxDown+2] - (data[idxUp] + data[idxUp+1] + data[idxUp+2])) / 3;

                const gradMag = Math.sqrt(gx * gx + gy * gy);
                if (gradMag > 15) {
                  // Upright alignment score: high gradient aligned with 0, 90, 180, 270 degrees
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

        // Fine search around bestAngle (+-6 degrees with step 1)
        let fineAngle = bestAngle;
        let fineMaxScore = -Infinity;
        for (let angle = bestAngle - 6; angle <= bestAngle + 6; angle += 1) {
          const normAngle = (angle + 360) % 360;
          testCtx.clearRect(0, 0, w, h);
          testCtx.save();
          testCtx.translate(cx, cy);
          testCtx.rotate((normAngle * Math.PI) / 180);
          testCtx.drawImage(srcCanvas, -cx, -cy);
          testCtx.restore();

          const imgData = testCtx.getImageData(0, 0, w, h);
          const data = imgData.data;
          let edgeScore = 0;
          for (let y = Math.floor(cy - radius); y < cy + radius; y += 3) {
            for (let x = Math.floor(cx - radius); x < cx + radius; x += 3) {
              const dxCenter = x - cx;
              const dyCenter = y - cy;
              if (dxCenter * dxCenter + dyCenter * dyCenter > radius * radius) continue;

              const idxRight = (y * w + (x + 2)) * 4;
              const idxLeft = (y * w + (x - 2)) * 4;
              const idxDown = ((y + 2) * w + x) * 4;
              const idxUp = ((y - 2) * w + x) * 4;

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

        // Convert rotation angle to slider percentage (0 to 100%)
        let calculatedPercent = Math.round(((360 - fineAngle) % 360) / 3.6);
        calculatedPercent = Math.max(5, Math.min(95, calculatedPercent));

        return {
          type: 'rotation',
          angle: fineAngle,
          percent: calculatedPercent,
          confidence: 0.85,
        };
      });
    } catch (err) {
      logger.warn(`analyzeCaptchaImage error: ${err.message}`);
      return { type: 'unknown', percent: 50, confidence: 0 };
    }
  }
}

export default CaptchaSolver;
