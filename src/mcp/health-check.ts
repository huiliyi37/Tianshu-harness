/**
 * Health check and circuit breaker for MCP servers.
 *
 * Motivation: According to "What a Random Draw from the MCP Registry Contains"
 * (arXiv 2609.10962), 48.8% of MCP servers successfully handshake, while
 * 37.5% fail to start at all. Without health checks, agents get stuck on
 * dead servers with no fallback or retry mechanism.
 *
 * This module adds:
 * 1. Proactive health checks (periodic `tools/list` ping)
 * 2. Circuit breaker state machine (healthy → degraded → failed → retrying)
 * 3. Exponential backoff for retries
 * 4. Automatic recovery when servers come back online
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export type HealthState = 'healthy' | 'degraded' | 'failed' | 'retrying'

export interface HealthCheckConfig {
  /** Interval between health checks for healthy servers (ms). */
  intervalMs: number
  /** Timeout for a single health check (ms). */
  timeoutMs: number
  /** Number of consecutive failures before marking server as failed. */
  failureThreshold: number
  /** Base delay for exponential backoff retries (ms). */
  retryBackoffBaseMs: number
  /** Maximum number of retry attempts before giving up. */
  maxRetries: number
}

export const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  intervalMs: 60_000,        // Check every 60s
  timeoutMs: 10_000,         // 10s timeout per check
  failureThreshold: 3,       // 3 consecutive failures → failed
  retryBackoffBaseMs: 5_000, // Start with 5s retry delay
  maxRetries: 10,            // Give up after 10 retries
}

interface HealthRecord {
  state: HealthState
  consecutiveFailures: number
  retryAttempt: number
  lastCheckAt: number
  lastSuccessAt: number
  timer?: ReturnType<typeof setTimeout>
}

export class HealthChecker {
  private records = new Map<string, HealthRecord>()
  private config: HealthCheckConfig

  constructor(config: Partial<HealthCheckConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_CHECK_CONFIG, ...config }
  }

  /**
   * Register a server for health monitoring.
   * Starts periodic checks immediately.
   */
  register(
    serverId: string,
    client: Client,
    onStateChange: (serverId: string, state: HealthState) => void,
  ): void {
    // Clear existing timer if re-registering
    const existing = this.records.get(serverId)
    if (existing?.timer) clearTimeout(existing.timer)

    const record: HealthRecord = {
      state: 'healthy',
      consecutiveFailures: 0,
      retryAttempt: 0,
      lastCheckAt: Date.now(),
      lastSuccessAt: Date.now(),
    }
    this.records.set(serverId, record)

    // Start periodic checks
    this._scheduleCheck(serverId, client, onStateChange)
  }

  /**
   * Unregister a server (stops health checks).
   */
  unregister(serverId: string): void {
    const record = this.records.get(serverId)
    if (record?.timer) clearTimeout(record.timer)
    this.records.delete(serverId)
  }

  /**
   * Get current health state for a server.
   */
  getState(serverId: string): HealthState | undefined {
    return this.records.get(serverId)?.state
  }

  /**
   * Manually trigger a health check (used on reconnect success).
   */
  async check(serverId: string, client: Client): Promise<boolean> {
    try {
      await this._performCheck(client)
      return true
    } catch {
      return false
    }
  }

  /**
   * Stop all health checks (used on shutdown).
   */
  shutdown(): void {
    for (const record of this.records.values()) {
      if (record.timer) clearTimeout(record.timer)
    }
    this.records.clear()
  }

  private _scheduleCheck(
    serverId: string,
    client: Client,
    onStateChange: (serverId: string, state: HealthState) => void,
  ): void {
    const record = this.records.get(serverId)
    if (!record) return

    // Degraded servers are still actively monitored at the normal interval;
    // only failed/retrying servers fall back to exponential backoff.
    const delay = record.state === 'healthy' || record.state === 'degraded'
      ? this.config.intervalMs
      : this._computeBackoff(record.retryAttempt)

    record.timer = setTimeout(() => {
      this._runCheck(serverId, client, onStateChange)
    }, delay)
  }

  private async _runCheck(
    serverId: string,
    client: Client,
    onStateChange: (serverId: string, state: HealthState) => void,
  ): Promise<void> {
    const record = this.records.get(serverId)
    if (!record) return

    record.lastCheckAt = Date.now()

    try {
      await this._performCheck(client)
      // Success: reset failure counter and update state
      const wasUnhealthy = record.state !== 'healthy'
      record.consecutiveFailures = 0
      record.retryAttempt = 0
      record.lastSuccessAt = Date.now()
      record.state = 'healthy'

      if (wasUnhealthy) {
        onStateChange(serverId, 'healthy')
      }
    } catch (err) {
      // Failure: increment counter and update state
      record.consecutiveFailures++

      const previousState = record.state
      if (record.state === 'healthy' && record.consecutiveFailures >= this.config.failureThreshold) {
        record.state = 'degraded'
      } else if (record.state === 'degraded') {
        record.state = 'failed'
        record.retryAttempt = 0
      } else if (record.state === 'failed' || record.state === 'retrying') {
        record.state = 'retrying'
        record.retryAttempt++
        
        // Give up after max retries
        if (record.retryAttempt >= this.config.maxRetries) {
          record.state = 'failed'
          // Notify listeners that retries are exhausted before stopping,
          // otherwise subscribers would observe 'retrying' forever.
          if (record.state !== previousState) {
            onStateChange(serverId, record.state)
          }
          // Stop scheduling further checks for permanently failed servers
          return
        }
      }

      if (record.state !== previousState) {
        onStateChange(serverId, record.state)
      }
    }

    // Schedule next check
    this._scheduleCheck(serverId, client, onStateChange)
  }

  private async _performCheck(client: Client): Promise<void> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined

    // Enforce the timeout locally instead of relying solely on the server
    // (or SDK transport) honoring the AbortSignal — a hung server must not
    // be able to block the health-check loop forever.
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error(`Health check timed out after ${this.config.timeoutMs}ms`))
      }, this.config.timeoutMs)
    })

    try {
      // Ping the server by listing tools
      const result = await Promise.race([
        client.request(
          { method: 'tools/list' },
          // @ts-expect-error: SDK types don't expose AbortSignal option
          { signal: controller.signal },
        ),
        timeoutPromise,
      ])

      if (!result || typeof result !== 'object') {
        throw new Error('Invalid tools/list response')
      }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private _computeBackoff(attempt: number): number {
    // Exponential backoff: base * 2^attempt, capped at 5 minutes
    const delay = this.config.retryBackoffBaseMs * Math.pow(2, attempt)
    return Math.min(delay, 300_000)
  }
}
