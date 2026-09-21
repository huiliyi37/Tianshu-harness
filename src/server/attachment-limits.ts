/**
 * 附件守卫上限——单一来源。
 *
 * 消费方：
 *  - `session-routes.ts` 的入站校验（POST /sessions 建会话带附件、
 *    POST /sessions/:id/prompt、POST /sessions/:id/queue）；
 *  - `session-manager.ts` 的队列归并配额治理（queue lane 的附件并入下一轮
 *    run 时按同一上限截断）。
 *
 * 两侧读同一组常量，避免"路由放行、归并拒绝"的语义漂移。
 */

/** 单轮图片张数上限（provider 侧视觉输入约束）。 */
export const MAX_IMAGES = 4

/** 单轮文档附件个数上限（word/excel/pdf — 服务端抽取文本）。 */
export const MAX_DOCUMENTS = 4

/** 单个文档 base64 解码后的字节上限。 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** 单张图片解码后字节上限 — 与 TUI（image-attach.ts）、桌面端压缩出口
 *  （image-compress.ts MAX_OUTPUT_BYTES）、read_file 工具统一 10MB；
 *  DeepSeek 官方 base64 内联上限 32MiB，10MB 在安全区内。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
