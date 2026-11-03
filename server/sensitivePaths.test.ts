import { describe, expect, it } from 'vitest'
import { foldName, globReachesSensitive, isProtectedAbsolute, isSensitiveRelative } from './sensitivePaths'

describe('isSensitiveRelative', () => {
  it.each(['.env', '.env.local', 'sub/.ENV', '.git/config', 'a/.git', 'key.pem', 'id_rsa', 'id_ed25519.pub', '.ssh/config', '.aws/credentials', '.npmrc', '.netrc', 'credentials.json', 'a/KEY.PEM', 'x.p12', 'x.pfx', 'x.key', '.gnupg/pubring.kbx', 'home/.kube/config', '.docker/config.json', '.pypirc', '.git-credentials', 'a/.PGPASS', '.htpasswd'])('refuses %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(true)
  })
  it.each(['src/env.ts', 'environment.md', 'gitignore.txt', 'a/b.txt', 'notes.md', 'kube/config.yaml', 'docker/Dockerfile', 'pypirc.md'])('allows %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(false)
  })
})

describe('isProtectedAbsolute', () => {
  it('matches inside a root only', () => {
    expect(isProtectedAbsolute('/x/data/api-token', ['/x/data'])).toBe(true)
    expect(isProtectedAbsolute('/x/data', ['/x/data'])).toBe(true)
    expect(isProtectedAbsolute('/x/database', ['/x/data'])).toBe(false)
    expect(isProtectedAbsolute('/x/data/a', [])).toBe(false)
  })
})

describe('Unicode folding', () => {
  it('folds the characters a case-insensitive file system folds', () => {
    expect(foldName('\u017Fsh')).toBe('ssh')
    expect(foldName('\u212A')).toBe('k')
    expect(foldName('Stra\u00DFe')).toBe('strasse')
  })
  it.each(['.\u017Fsh/config', '.\u017Fsh', '.pgpa\u017F\u017F', 'credential\u017F.json', '.ENV', '.Env.local', '.\u212Aube/config', 'a/ID_RSA'])('refuses %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(true)
  })
  it.each(['.\u017Fit', '.\u017Fsh2', 'gh/hosts.yml'])('does not invent a match for %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(false)
  })
  it('folds in globs and protected roots too', () => {
    expect(globReachesSensitive('**/.\u017Fsh/*')).toBe(true)
    expect(globReachesSensitive('**/.\u017Fit/*')).toBe(false)
    expect(isProtectedAbsolute('/x/DATA\u017F/a', ['/x/datas'])).toBe(true)
    expect(isProtectedAbsolute('/x/data\u017F', ['/x/data'])).toBe(false)
  })
})

describe('wider denylist', () => {
  it.each([
    '.credentials.json', '.claude/.credentials.json', '.vault-token', '.s3cfg', '.boto', 'kubeconfig', 'a/Kubeconfig',
    '.config/gh', '.config/gh/hosts.yml', 'home/.config/gcloud/creds.db', '.azure/x', 'terraform.tfstate', 'x.tfstate.backup', 'prod.tfvars', 'prod.tfvars.json', 'x.auto.tfvars', 'x.auto.tfvars.json', 'Prod.TFVARS.JSON', 'a/x.auto.tfvars.bak',
    '.bash_history', '.zsh_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', 'fish_history', 'secrets.yml', 'secrets.yaml', 'secrets.json',
  ])('refuses %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(true)
    expect(globReachesSensitive(p)).toBe(true)
  })
  it.each(['.config', '.config/other/hosts.yml', 'config/gh/x', 'hosts.yml', 'gh/hosts.yml', 'history.md', 'secrets.md', 'my.tfstates', 'tfvars.md', 'tfvars.jsonx.md', 'auto.tfvarsx', 'kubeconfig.md', '.credentials.json.md'])('allows %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(false)
  })
})
