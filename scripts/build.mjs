// Cross-platform build steps (npm runs scripts with cmd.exe on Windows, so no rm/cp/chmod).
//   node scripts/build.mjs clean   remove dist/
//   node scripts/build.mjs ui      copy src/ui into dist/ui and make the CLI executable
import { chmodSync, cpSync, rmSync } from 'node:fs'

const step = process.argv[2]
if (step === 'clean') {
  rmSync('dist', { recursive: true, force: true })
} else if (step === 'ui') {
  cpSync('src/ui', 'dist/ui', { recursive: true })
  if (process.platform !== 'win32') chmodSync('dist/cli.js', 0o755)
} else {
  console.error(`Unknown step: ${step ?? '(none)'}`)
  process.exit(2)
}
