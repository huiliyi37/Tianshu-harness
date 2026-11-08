/**
 * Gateway message decoding utilities.
 *
 * Handles the various data formats that the QQ Bot WebSocket can deliver
 * (string, Buffer, Buffer[], ArrayBuffer).
 */

export function decodeGatewayMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

export function readOptionalMessageSceneExt(event: Record<string, unknown>): string[] | undefined {
  if (!("message_scene" in event)) {
    return undefined;
  }
  const scene = event.message_scene as { ext?: string[] } | undefined;
  return scene?.ext;
}
