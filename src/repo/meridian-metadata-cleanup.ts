import { isFilesystemMetadata } from '../utils/file-metadata.js'
import { toPosixPath } from '../path-format.js'

/** Remove historical filesystem sidecars once, without changing schema migrations. */
export function purgeFilesystemMetadataRows(db: any): void {
  const key = 'filesystem_metadata_cleanup_v1'
  const marker = db.prepare('SELECT value FROM meridian_meta WHERE key = ?')
  if (marker.get(key)?.value === '1') return
  const metadataPath = (file: unknown): number =>
    typeof file === 'string' && toPosixPath(file).split('/').some(isFilesystemMetadata) ? 1 : 0
  db.function('rivet_metadata_path', { deterministic: true }, metadataPath)
  let knownFiles = new Set<string>()
  db.function('rivet_metadata_endpoint', { deterministic: true }, (id: unknown): number => {
    if (typeof id !== 'string' || !/:\d+$/.test(id)) return 0
    const boundary = id.lastIndexOf(':', id.lastIndexOf(':') - 1)
    if (boundary < 1) return 0
    let file = id.slice(0, boundary)
    // Route names may contain colons; prefer an exact stored file prefix.
    if (!knownFiles.has(file)) {
      for (let colon = id.indexOf(':'); colon >= 0 && colon < boundary; colon = id.indexOf(':', colon + 1)) {
        const prefix = id.slice(0, colon)
        if (knownFiles.has(prefix)) file = prefix
      }
    }
    return metadataPath(file)
  })
  const cleanup = db.transaction(() => {
    // Recheck under the SQLite writer lock: another opener may have completed it.
    if (marker.get(key)?.value === '1') return
    knownFiles = new Set(db.prepare('SELECT path FROM files').all().map((row: { path: string }) => row.path))
    db.prepare(`DELETE FROM edges
      WHERE source_id IN (SELECT id FROM symbols WHERE rivet_metadata_path(file_path))
        OR target_id IN (SELECT id FROM symbols WHERE rivet_metadata_path(file_path))
        OR source_id IN (SELECT path || ':*:0' FROM files WHERE rivet_metadata_path(path))
        OR target_id IN (SELECT path || ':*:0' FROM files WHERE rivet_metadata_path(path))
        OR (NOT EXISTS (SELECT 1 FROM symbols WHERE id = edges.source_id) AND rivet_metadata_endpoint(source_id))
        OR (NOT EXISTS (SELECT 1 FROM symbols WHERE id = edges.target_id) AND rivet_metadata_endpoint(target_id))`).run()
    db.prepare('DELETE FROM symbols WHERE rivet_metadata_path(file_path)').run()
    db.prepare('DELETE FROM co_edits WHERE rivet_metadata_path(file_a) OR rivet_metadata_path(file_b)').run()
    db.prepare('DELETE FROM access_log WHERE rivet_metadata_path(file_path)').run()
    db.prepare('DELETE FROM files WHERE rivet_metadata_path(path)').run()
    db.prepare('INSERT OR REPLACE INTO meridian_meta (key, value) VALUES (?, ?)').run(key, '1')
  })
  cleanup.immediate()
}
