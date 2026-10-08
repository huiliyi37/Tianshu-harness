/** AppleDouble sidecars are filesystem metadata, not application documents. */
export function isFilesystemMetadata(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store'
}
