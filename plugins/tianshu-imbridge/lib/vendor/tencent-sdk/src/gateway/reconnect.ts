/**
 * WebSocket reconnection state machine and close-code handler.
 */

import type { Logger } from "../types.js";
import {
  GatewayCloseCode,
  MAX_QUICK_DISCONNECT_COUNT,
  MAX_RECONNECT_ATTEMPTS,
  QUICK_DISCONNECT_THRESHOLD,
  RATE_LIMIT_DELAY,
  RECONNECT_DELAYS,
} from "./constants.js";

export interface CloseAction {
  shouldReconnect: boolean;
  reconnectDelay?: number;
  clearSession: boolean;
  refreshToken: boolean;
  fatal: boolean;
  reason: string;
}

export class ReconnectState {
  private attempts = 0;
  private lastConnectTime = 0;
  private quickDisconnectCount = 0;

  constructor(
    private readonly accountId: string,
    private readonly log?: Logger,
  ) {}

  onConnected(): void {
    this.attempts = 0;
    this.lastConnectTime = Date.now();
  }

  isExhausted(): boolean {
    return this.attempts >= MAX_RECONNECT_ATTEMPTS;
  }

  getNextDelay(customDelay?: number): number {
    const delay =
      customDelay ?? RECONNECT_DELAYS[Math.min(this.attempts, RECONNECT_DELAYS.length - 1)];
    this.attempts++;
    this.log?.debug?.(`[${this.accountId}] Reconnecting in ${delay}ms (attempt ${this.attempts})`);
    return delay;
  }

  handleClose(code: number, isAborted: boolean): CloseAction {
    if (
      code === GatewayCloseCode.INSUFFICIENT_INTENTS ||
      code === GatewayCloseCode.DISALLOWED_INTENTS
    ) {
      const reason =
        code === GatewayCloseCode.INSUFFICIENT_INTENTS ? "offline/sandbox-only" : "banned";
      this.log?.error(`[${this.accountId}] Bot is ${reason}. Please contact QQ platform.`);
      return {
        shouldReconnect: false,
        clearSession: false,
        refreshToken: false,
        fatal: true,
        reason,
      };
    }

    if (code === GatewayCloseCode.AUTH_FAILED) {
      this.log?.info(`[${this.accountId}] Invalid token (4004), will refresh token and reconnect`);
      return {
        shouldReconnect: !isAborted,
        clearSession: false,
        refreshToken: true,
        fatal: false,
        reason: "invalid token (4004)",
      };
    }

    if (code === GatewayCloseCode.RATE_LIMITED) {
      this.log?.info(`[${this.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms`);
      return {
        shouldReconnect: !isAborted,
        reconnectDelay: RATE_LIMIT_DELAY,
        clearSession: false,
        refreshToken: false,
        fatal: false,
        reason: "rate limited (4008)",
      };
    }

    if (
      code === GatewayCloseCode.INVALID_SESSION ||
      code === GatewayCloseCode.SEQ_OUT_OF_RANGE ||
      code === GatewayCloseCode.SESSION_TIMEOUT
    ) {
      const codeDesc: Record<number, string> = {
        [GatewayCloseCode.INVALID_SESSION]: "session no longer valid",
        [GatewayCloseCode.SEQ_OUT_OF_RANGE]: "invalid seq on resume",
        [GatewayCloseCode.SESSION_TIMEOUT]: "session timed out",
      };
      this.log?.info(`[${this.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
      return {
        shouldReconnect: !isAborted,
        clearSession: true,
        refreshToken: true,
        fatal: false,
        reason: codeDesc[code],
      };
    }

    if (code >= GatewayCloseCode.SERVER_ERROR_START && code <= GatewayCloseCode.SERVER_ERROR_END) {
      this.log?.info(`[${this.accountId}] Internal error (${code}), will re-identify`);
      return {
        shouldReconnect: !isAborted && code !== GatewayCloseCode.NORMAL,
        clearSession: true,
        refreshToken: true,
        fatal: false,
        reason: `internal error (${code})`,
      };
    }

    const connectionDuration = Date.now() - this.lastConnectTime;
    if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && this.lastConnectTime > 0) {
      this.quickDisconnectCount++;
      this.log?.debug?.(
        `[${this.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${this.quickDisconnectCount}`,
      );

      if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
        this.log?.error(
          `[${this.accountId}] Too many quick disconnects. This may indicate a permission issue.`,
        );
        this.quickDisconnectCount = 0;
        return {
          shouldReconnect: !isAborted && code !== 1000,
          reconnectDelay: RATE_LIMIT_DELAY,
          clearSession: false,
          refreshToken: false,
          fatal: false,
          reason: "too many quick disconnects",
        };
      }
    } else {
      this.quickDisconnectCount = 0;
    }

    return {
      shouldReconnect: !isAborted && code !== GatewayCloseCode.NORMAL,
      clearSession: false,
      refreshToken: false,
      fatal: false,
      reason: `close code ${code}`,
    };
  }
}
