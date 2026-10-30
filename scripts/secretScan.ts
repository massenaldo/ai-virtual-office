// Pure scan of built files for anything that looks like the API key. The CLI in checkSecrets.ts feeds it the real files.

export type BuiltFile = { path: string; text: string }

const SERVER_BUNDLE = new Set(['dist-server/index.js', 'dist-server/index.js.map'])
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{10,}/

/** One string per problem. The variable NAME may appear in the server bundle (the server reads it); never anywhere else, and no value anywhere. */
export function findSecretLeaks(files: BuiltFile[], keyValue: string | undefined): string[] {
  const problems: string[] = []
  for (const { path, text } of files) {
    if (keyValue !== undefined && keyValue.length >= 8 && text.includes(keyValue)) problems.push(`${path}: contains the ANTHROPIC_API_KEY value`)
    if (KEY_SHAPE.test(text)) problems.push(`${path}: contains an sk-ant- key`)
    if (text.includes('ANTHROPIC_API_KEY') && !SERVER_BUNDLE.has(path)) problems.push(`${path}: mentions ANTHROPIC_API_KEY (only dist-server/index.js and its source map may)`)
  }
  return problems
}
