/**
 * In-memory state tracking store for all configured notebooks and engine health.
 */
export class StateStore {
  constructor() {
    this.startedAt = new Date();
    this.roundCount = 0;
    this.notebookStates = new Map();
    this.isManualRoundRunning = false;
    this.lastLoginStatus = { loggedIn: true, checkedAt: new Date() };
  }

  /**
   * Initialize or update state entry for a notebook.
   * @param {object} notebookConfig
   */
  initNotebook(notebookConfig) {
    if (!this.notebookStates.has(notebookConfig.id)) {
      this.notebookStates.set(notebookConfig.id, {
        id: notebookConfig.id,
        name: notebookConfig.name || notebookConfig.id,
        url: notebookConfig.url,
        action: notebookConfig.action || 'smart',
        status: 'INITIALIZING',
        lastCheckedAt: null,
        lastSuccessAt: null,
        lastDurationMs: 0,
        totalSuccessCount: 0,
        totalFailureCount: 0,
        consecutiveFailures: 0,
        lastError: null,
        lastActionTaken: 'none',
        restartedCount: 0,
      });
    }
  }

  /**
   * Get single notebook state.
   * @param {string} id
   */
  getNotebookState(id) {
    return this.notebookStates.get(id);
  }

  /**
   * Get all notebook states as array.
   */
  getAllStates() {
    return Array.from(this.notebookStates.values());
  }

  /**
   * Record successful keepalive result.
   */
  recordSuccess(id, { action, status, durationMs, restarted }) {
    const s = this.notebookStates.get(id);
    if (!s) return;
    s.status = 'RUNNING';
    s.lastCheckedAt = new Date();
    s.lastSuccessAt = new Date();
    s.lastDurationMs = durationMs || 0;
    s.totalSuccessCount += 1;
    s.consecutiveFailures = 0;
    s.lastError = null;
    s.lastActionTaken = status || action;
    if (restarted) {
      s.restartedCount += 1;
    }
  }

  /**
   * Record failure result.
   */
  recordFailure(id, errorMsg, durationMs = 0, isAuthExpired = false) {
    const s = this.notebookStates.get(id);
    if (!s) return;
    s.status = isAuthExpired ? 'EXPIRED' : 'ERROR';
    s.lastCheckedAt = new Date();
    s.lastDurationMs = durationMs;
    s.totalFailureCount += 1;
    s.consecutiveFailures += 1;
    s.lastError = errorMsg;
  }

  /**
   * Get formatted uptime string.
   */
  getUptimeString() {
    const totalSeconds = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }

  /**
   * Generate text / structured summary.
   */
  getSummary() {
    const all = this.getAllStates();
    const running = all.filter(n => n.status === 'RUNNING').length;
    const errors = all.filter(n => n.status === 'ERROR' || n.status === 'EXPIRED').length;
    return {
      roundCount: this.roundCount,
      totalNotebooks: all.length,
      running,
      errors,
      uptime: this.getUptimeString(),
      items: all,
    };
  }
}

export const stateStore = new StateStore();
export default stateStore;
