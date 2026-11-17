/**
 * Entry point: `npm run sim -- --config <file>`.
 * The simulation itself is added in the next steps; for now the script checks the arguments and the config file.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from './args';

function main(argv: readonly string[]): void {
  const { flags } = parseArgs(argv);
  const configPath = flags.config;
  if (typeof configPath !== 'string') {
    console.error('usage: npm run sim -- --config <file>');
    process.exitCode = 2;
    return;
  }
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  console.log(`loaded ${configPath}: ${JSON.stringify(config).length} bytes`);
}

main(process.argv.slice(2));
