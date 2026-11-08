/**
 * Event dispatcher — convert raw WebSocket op=0 events into typed events.
 *
 * Pure mapping logic with zero side effects.
 */

import type {
  C2CMessageEvent,
  GroupMessageEvent,
  GuildMessageEvent,
  InteractionEvent,
  Logger,
} from "../types.js";
import { readOptionalMessageSceneExt } from "./codec.js";
import { GatewayEvent } from "./constants.js";

// ============ Inbound sub-structures ============

/** A media attachment on an inbound message. */
export interface InboundAttachment {
  content_type: string;
  url: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  /** WAV URL for voice messages (QQ server-side conversion). */
  voice_wav_url?: string;
  /** ASR transcription text for voice messages (QQ built-in speech recognition). */
  asr_refer_text?: string;
}

/** One element from the `msg_elements` array pushed by QQ. */
export interface InboundMsgElement {
  /** Sequential message index (used for quote resolution). */
  msg_idx?: string;
  /** Text content of this element. */
  content?: string;
  /** Attachments carried by this element. */
  attachments?: InboundAttachment[];
}

// ============ Inbound message ============

/** Inbound message envelope normalised across C2C / Group / Guild scopes. */
export interface InboundMessage {
  /** Raw event type from the gateway. */
  rawEventType: string;
  /** Conversation kind. */
  kind: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: InboundAttachment[];
  refMsgIdx?: string;
  msgIdx?: string;
  msgType?: number;
  /** @mentions list (group events only). */
  mentions?: GroupMessageEvent["mentions"];
  /** Raw message scene info. */
  messageScene?: { source?: string; ext?: string[] };
  /**
   * Raw msg_elements from the QQ push event.
   *
   * When a user quotes/replies to a message, `msg_elements[0]` contains the
   * quoted message's content and attachments. This is the **only** source of
   * truth when the quoted message is not in our RefIndexStore (cache miss).
   */
  msgElements?: InboundMsgElement[];
  /**
   * The original platform event object, transparently forwarded.
   *
   * Use this when you need fields not yet mapped to the normalized interface.
   * The shape depends on `kind`:
   * - `"c2c"` → `C2CMessageEvent`
   * - `"group"` → `GroupMessageEvent`
   * - `"guild"` / `"dm"` → `GuildMessageEvent`
   *
   * New platform fields are immediately accessible here without SDK updates.
   */
  raw: C2CMessageEvent | GroupMessageEvent | GuildMessageEvent;
}

export type DispatchResult =
  | { action: "ready"; data: unknown; sessionId: string }
  | { action: "resumed"; data: unknown }
  | { action: "message"; msg: InboundMessage }
  | { action: "interaction"; event: InteractionEvent }
  | { action: "raw"; type: string; data: unknown }
  | { action: "ignore" };

interface Refs {
  refMsgIdx?: string;
  msgIdx?: string;
}

const REF_INDEX_KEY = "msg_idx";

/**
 * Parse `ref_idx` and `msg_idx` from message_scene.ext + msg_elements.
 */
function parseRefIndices(
  ext: string[] | undefined,
  msgType?: number,
  msgElements?: Array<{ msg_idx?: string }>,
): Refs {
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;

  if (Array.isArray(ext)) {
    for (const entry of ext) {
      if (typeof entry !== "string") {
        continue;
      }
      const eq = entry.indexOf("=");
      if (eq < 0) {
        continue;
      }
      const key = entry.slice(0, eq).trim();
      const val = entry.slice(eq + 1).trim();
      if (!val) {
        continue;
      }
      if (key === REF_INDEX_KEY) {
        msgIdx = val;
      } else if (key === "ref_msg_idx") {
        refMsgIdx = val;
      }
    }
  }

  if (msgType === 103 && Array.isArray(msgElements)) {
    for (const el of msgElements) {
      if (el?.msg_idx) {
        refMsgIdx = el.msg_idx;
        break;
      }
    }
  }

  return { refMsgIdx, msgIdx };
}

export function dispatchEvent(
  eventType: string,
  data: unknown,
  _accountId: string,
  _log?: Logger,
): DispatchResult {
  if (eventType === GatewayEvent.READY) {
    const d = data as { session_id: string };
    return { action: "ready", data, sessionId: d.session_id };
  }

  if (eventType === GatewayEvent.RESUMED) {
    return { action: "resumed", data };
  }

  if (eventType === GatewayEvent.C2C_MESSAGE_CREATE) {
    const ev = data as C2CMessageEvent;
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
    return {
      action: "message",
      msg: {
        rawEventType: eventType,
        kind: "c2c",
        senderId: ev.author.user_openid,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        messageScene: ev.message_scene,
        msgElements: ev.msg_elements,
        raw: ev,
      },
    };
  }

  if (eventType === GatewayEvent.AT_MESSAGE_CREATE) {
    const ev = data as GuildMessageEvent;
    const refs = parseRefIndices(
      readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
    );
    return {
      action: "message",
      msg: {
        rawEventType: eventType,
        kind: "guild",
        senderId: ev.author.id,
        senderName: ev.author.username,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        channelId: ev.channel_id,
        guildId: ev.guild_id,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        raw: ev,
      },
    };
  }

  if (eventType === GatewayEvent.DIRECT_MESSAGE_CREATE) {
    const ev = data as GuildMessageEvent;
    const refs = parseRefIndices(
      readOptionalMessageSceneExt(ev as unknown as Record<string, unknown>),
    );
    return {
      action: "message",
      msg: {
        rawEventType: eventType,
        kind: "dm",
        senderId: ev.author.id,
        senderName: ev.author.username,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        guildId: ev.guild_id,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        raw: ev,
      },
    };
  }

  if (
    eventType === GatewayEvent.GROUP_AT_MESSAGE_CREATE ||
    eventType === GatewayEvent.GROUP_MESSAGE_CREATE
  ) {
    const ev = data as GroupMessageEvent;
    const refs = parseRefIndices(ev.message_scene?.ext, ev.message_type, ev.msg_elements);
    return {
      action: "message",
      msg: {
        rawEventType: eventType,
        kind: "group",
        senderId: ev.author.member_openid,
        senderName: ev.author.username,
        senderIsBot: ev.author.bot,
        content: ev.content,
        messageId: ev.id,
        timestamp: ev.timestamp,
        groupOpenid: ev.group_openid,
        attachments: ev.attachments,
        refMsgIdx: refs.refMsgIdx,
        msgIdx: refs.msgIdx,
        msgType: ev.message_type,
        mentions: ev.mentions,
        messageScene: ev.message_scene,
        msgElements: ev.msg_elements,
        raw: ev,
      },
    };
  }

  if (eventType === GatewayEvent.INTERACTION_CREATE) {
    return { action: "interaction", event: data as InteractionEvent };
  }

  // All other gateway events are forwarded as raw events.
  // This covers guild/group/friend lifecycle, reactions, and any future
  // platform events — zero SDK changes required for new event types.
  return { action: "raw", type: eventType, data };
}
