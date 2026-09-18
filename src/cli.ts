import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { HefaetusEngine, EngineOptions } from './engine';

// Load .env from current directory or nearby
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold('Hefaetus')} - Autonomous Dependency Remediation Agent

${chalk.bold('USAGE:')}
  $ hefaetus [OPTIONS]
  $ npx hefaetus-remediator [OPTIONS]

${chalk.bold('OPTIONS:')}
  -d, --target-dir <path>     Target repository directory (default: current directory)
  -p, --packages <list>       Comma-separated dependencies to remediate (e.g. uuid@^9.0.0,glob@^10.3.10)
  -b, --branch <name>         Git remediation branch name
  -l, --max-loops <num>       Maximum self-healing loop attempts (default: 6)
  -t, --test-command <cmd>    Custom test command to run (default: npm test)
  -h, --help                  Show this help message

${chalk.bold('ENVIRONMENT VARIABLES:')}
  GEMINI_API_KEY              Google Gemini API key (Free Tier supported)
  OPENAI_API_KEY              OpenAI API key (optional)
  ANTHROPIC_API_KEY           Anthropic Claude API key (optional)
  GITHUB_TOKEN / GH_PAT       GitHub token for push and Pull Request creation

${chalk.bold('EXAMPLES:')}
  $ npx hefaetus-remediator
  $ npx hefaetus-remediator --packages "uuid@^9.0.0,glob@^10.3.10"
  $ npx hefaetus-remediator --target-dir ../my-service --max-loops 5
`);
}

function parseArgs(args: string[]): EngineOptions {
  const options: EngineOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-d' || arg === '--target-dir') {
      options.targetDir = args[++i];
    } else if (arg === '-p' || arg === '--packages') {
      options.packages = args[++i];
    } else if (arg === '-b' || arg === '--branch') {
      options.branchName = args[++i];
    } else if (arg === '-l' || arg === '--max-loops') {
      options.maxAttempts = parseInt(args[++i], 10);
    } else if (arg === '-t' || arg === '--test-command') {
      options.testCommand = args[++i];
    }
  }

  return options;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  const engine = new HefaetusEngine(options.targetDir);
  await engine.execute(options);
}

main().catch((err) => {
  console.error(chalk.red('\n[Hefaetus Fatal Error]:'), err.message || err);
  process.exit(1);
});
