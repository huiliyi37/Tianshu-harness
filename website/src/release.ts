import manifest from '../../package.json'

export const release = {
  version: manifest.version,
  license: manifest.license,
  nodeMajor: manifest.engines.node.match(/\d+/)?.[0] ?? '24',
}
