import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { DependencyScanner, TargetPackageDef } from './scanner';
import { SandboxRunner } from './runner';
import { RemediationLLMClient } from './llm';
import { GitManager, PRResult } from './git';

export interface EngineOptions {
  targetDir?: string;
  packages?: string;
  branchName?: string;
  maxAttempts?: number;
  testCommand?: string;
  autoCommit?: boolean;
  createPR?: boolean;
}

export interface EngineResult {
  success: boolean;
  targetDir: string;
  branchName: string;
  packagesRemediated: { name: string; oldVersion: string; newVersion: string }[];
  healingAttemptsTaken: number;
  remediatedFiles: string[];
  prResult?: PRResult;
  error?: string;
}

export class HefaetusEngine {
  private targetDir: string;
  private scanner: DependencyScanner;
  private runner: SandboxRunner;
  private llm: RemediationLLMClient;
  private git: GitManager;

  constructor(targetDir?: string) {
    this.targetDir = path.resolve(targetDir || process.env.TARGET_DIR || process.cwd());
    this.scanner = new DependencyScanner(this.targetDir);
    this.runner = new SandboxRunner();
    this.llm = new RemediationLLMClient();
    this.git = new GitManager(this.targetDir);
  }

  private printBanner(): void {
    console.log(
      chalk.cyan(`
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║                                                                       ║
  ║      🔥  H E F A E T U S  ::  Autonomous Remediation Agent  🔥       ║
  ║      Self-Healing DevSecOps Pipeline for Breaking Dependency Bumps   ║
  ║                                                                       ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  `)
    );
  }

  /**
   * Extracts failing source file paths dynamically from test output stack traces.
   */
  private findFailingSourceFiles(testOutput: string): string[] {
    const found = new Set<string>();
    const lines = testOutput.split('\n');

    for (const line of lines) {
      // Matches path patterns like /app/src/file.js or src/file.js:12:3
      const match = line.match(
        /(?:[a-zA-Z]:)?[\\/](?:[^:()]+\/)?(src|lib|app)[\\/][^:()]+\.(?:js|ts|jsx|tsx)/i
      );
      if (match) {
        const rawPath = match[0];
        if (!rawPath.includes('node_modules') && !rawPath.includes('internal/')) {
          const rel = path.isAbsolute(rawPath)
            ? path.relative(this.targetDir, rawPath)
            : rawPath;
          if (fs.existsSync(path.join(this.targetDir, rel))) {
            found.add(rel);
          }
        }
      }
    }
    return Array.from(found);
  }

  /**
   * Scans project files to find which files import a given package.
   */
  private findFilesImportingPackage(packageName: string): string[] {
    const results: string[] = [];
    const searchDirs = ['src', 'lib', 'app', '.'];

    for (const dir of searchDirs) {
      const fullDir = path.join(this.targetDir, dir);
      if (fs.existsSync(fullDir)) {
        try {
          const entries = fs.readdirSync(fullDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
              const rel = dir === '.' ? entry.name : path.join(dir, entry.name);
              const content = fs.readFileSync(path.join(fullDir, entry.name), 'utf8');
              if (
                content.includes(`require('${packageName}`) ||
                content.includes(`require("${packageName}`) ||
                content.includes(`from '${packageName}`) ||
                content.includes(`from "${packageName}`)
              ) {
                results.push(rel);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return results;
  }

  /**
   * Runs the complete autonomous remediation pipeline.
   */
  public async execute(options: EngineOptions = {}): Promise<EngineResult> {
    this.printBanner();

    const branchName =
      options.branchName ||
      process.env.BRANCH_NAME ||
      'fix/hefaetus-autonomous-dependency-remediation';
    const maxAttempts = options.maxAttempts || Number(process.env.MAX_HEALING_ATTEMPTS) || 6;
    const testCommand = options.testCommand || process.env.TEST_COMMAND || 'npm test';

    const runnerInfo = await this.runner.getActiveModeDescription();
    const llmInfo = this.llm.getProviderInfo();

    console.log(chalk.bold('🛠️  Agent Runtime Configuration:'));
    console.log(`   • Target App Directory : ${chalk.yellow(this.targetDir)}`);
    console.log(`   • Execution Sandbox    : ${chalk.green(runnerInfo)}`);
    console.log(
      `   • Remediation Model    : ${chalk.magenta(
        `${llmInfo.provider.toUpperCase()} (${llmInfo.model})`
      )}`
    );
    console.log(`   • Target Git Branch    : ${chalk.blue(branchName)}`);
    console.log(`   • Healing Max Loops    : ${chalk.white(maxAttempts)}\n`);

    // Initialize Git baseline and prepare branch
    console.log(chalk.bold('🌿 Initializing Git workflow & branching...'));
    await this.git.ensureGitRepo();
    await this.git.prepareRemediationBranch(branchName);
    console.log(`✔ Switched to clean remediation branch: ${chalk.blue(branchName)}\n`);

    // -------------------------------------------------------------
    // STEP 1: Scan & Detect Vulnerable Dependencies
    // -------------------------------------------------------------
    console.log(
      chalk.bgBlue.white.bold(
        ' [STEP 1/5] SCANNING & BUMPING VULNERABLE DEPENDENCIES '
      )
    );

    const targetPackages = this.scanner.resolveTargetPackages(options.packages);
    const { packageBumps } = this.scanner.bumpDependencies(targetPackages);

    console.log(chalk.bold('🔍 Identified packages to bump:'));
    for (const b of packageBumps) {
      console.log(
        `   • ${chalk.bold(b.name)}: ${chalk.red(b.oldVersion)} ➔ ${chalk.green(
          b.newVersion
        )} (introducing target upgrade)`
      );
    }

    console.log(chalk.green('✔ Updated package.json. Triggering npm install...'));
    const installResult = await this.runner.runNpmInstall(this.targetDir);
    if (!installResult.success) {
      throw new Error(`npm install failed in ${this.targetDir}:\n${installResult.stderr}`);
    }
    console.log(
      chalk.green(
        `✔ npm install completed successfully (${installResult.durationMs}ms).\n`
      )
    );

    // -------------------------------------------------------------
    // STEP 2: Baseline Test Run (Detect Breaking Changes)
    // -------------------------------------------------------------
    console.log(
      chalk.bgRed.white.bold(
        ' [STEP 2/5] RUNNING SANDBOX TESTS (DETECTING BREAKING CHANGES) '
      )
    );
    console.log(`Executing '${testCommand}' in isolated environment...`);

    let testResult = await this.runner.runNpmTest(this.targetDir, testCommand);

    if (testResult.success) {
      console.log(
        chalk.green(
          '✔ Tests passed! No breaking change encountered with dependency bumps.'
        )
      );
    } else {
      console.log(
        chalk.red(
          `✖ Test Suite Failed as expected! (Exit Code: ${testResult.exitCode})`
        )
      );
      console.log(chalk.gray('---------------- Test Error Output ----------------'));
      console.log(
        chalk.yellow(
          (testResult.stderr || testResult.stdout).trim().slice(0, 1000)
        )
      );
      console.log(chalk.gray('---------------------------------------------------\n'));
    }

    // -------------------------------------------------------------
    // STEP 3: Autonomous Healing Loop (LLM Refactor -> Verify)
    // -------------------------------------------------------------
    console.log(
      chalk.bgMagenta.white.bold(
        ' [STEP 3/5] AUTONOMOUS SELF-HEALING REFACTORING LOOP '
      )
    );

    let healingSuccess = testResult.success;
    const analyses: string[] = [];
    const explanations: string[] = [];
    const healedFiles = new Set<string>();
    let attempt = 1;

    while (attempt <= maxAttempts && !healingSuccess) {
      console.log(
        chalk.cyan.bold(
          `\n🔄 Loop Iteration ${attempt} of ${maxAttempts}: Inspecting Failure & Requesting LLM Patch...`
        )
      );

      const combinedOutput = `${testResult.stderr}\n${testResult.stdout}`;

      // 1. Identify which package caused the failure
      let failingTarget = targetPackages.find((pkg) => {
        const baseName = pkg.sourceFile ? path.basename(pkg.sourceFile) : '';
        return (
          (baseName && combinedOutput.includes(baseName)) ||
          combinedOutput.includes(pkg.name)
        );
      });

      if (!failingTarget) {
        failingTarget =
          targetPackages.find(
            (pkg) => !pkg.sourceFile || !healedFiles.has(pkg.sourceFile)
          ) || targetPackages[0];
      }

      // 2. Resolve target file to patch
      let targetFileRel = failingTarget.sourceFile;
      if (!targetFileRel || !fs.existsSync(path.join(this.targetDir, targetFileRel))) {
        const detectedFiles = this.findFailingSourceFiles(combinedOutput);
        targetFileRel =
          detectedFiles.find((f) => !healedFiles.has(f)) || detectedFiles[0];
      }
      if (!targetFileRel) {
        const importing = this.findFilesImportingPackage(failingTarget.name);
        targetFileRel = importing.find((f) => !healedFiles.has(f)) || importing[0];
      }
      if (!targetFileRel) {
        targetFileRel = 'src/index.js';
      }

      const targetFilePath = path.join(this.targetDir, targetFileRel);
      if (!fs.existsSync(targetFilePath)) {
        console.warn(
          chalk.yellow(
            `⚠️ Could not locate source file at ${targetFilePath}. Attempting to locate root entry point.`
          )
        );
      }

      const currentFileContent = fs.existsSync(targetFilePath)
        ? fs.readFileSync(targetFilePath, 'utf8')
        : '';
      const currentBump = packageBumps.find((p) => p.name === failingTarget!.name);

      console.log(
        chalk.yellow(
          `🎯 Target identified: Package "${chalk.bold(failingTarget.name)}" -> File "${chalk.bold(
            targetFileRel
          )}"`
        )
      );

      const remediation = await this.llm.generatePatch({
        packageName: failingTarget.name,
        oldVersion: currentBump?.oldVersion || 'unknown',
        newVersion: failingTarget.targetVersion,
        filePath: targetFileRel,
        fileContent: currentFileContent,
        errorStackTrace: testResult.stderr || testResult.stdout,
        testOutput: testResult.stdout,
        attempt,
        maxAttempts,
      });

      analyses.push(`- **\`${failingTarget.name}\`**: ${remediation.breakingChangeAnalysis}`);
      explanations.push(`- **\`${targetFileRel}\`**: ${remediation.explanation}`);
      healedFiles.add(targetFileRel);

      console.log(chalk.bold('🤖 LLM Root Cause Analysis:'));
      console.log(`   ${chalk.italic(remediation.breakingChangeAnalysis)}`);
      console.log(chalk.bold('💡 Refactoring Strategy:'));
      console.log(`   ${chalk.italic(remediation.explanation)}`);

      console.log(
        chalk.yellow(`📝 Applying generated patch to ${targetFileRel}...`)
      );
      fs.writeFileSync(targetFilePath, remediation.patchedCode + '\n', 'utf8');

      console.log(
        `🧪 Re-verifying test suite in sandbox (Attempt ${attempt})...`
      );
      testResult = await this.runner.runNpmTest(this.targetDir, testCommand);

      if (testResult.success) {
        healingSuccess = true;
        console.log(
          chalk.green.bold(
            `\n✅ ALL TESTS PASSED ON ATTEMPT ${attempt}! Autonomous self-healing verified across upgraded packages.`
          )
        );
        console.log(chalk.gray(testResult.stdout.trim()));
        break;
      } else {
        console.log(
          chalk.red(
            `✖ Test suite still has failing tests on attempt ${attempt}. Capturing next error trace...`
          )
        );
        attempt++;
      }
    }

    if (!healingSuccess) {
      throw new Error(
        `Autonomous self-healing failed after ${maxAttempts} attempts. Halting pipeline.`
      );
    }

    // -------------------------------------------------------------
    // STEP 4: Git Commit & Open Pull Request
    // -------------------------------------------------------------
    console.log(
      chalk.bgGreen.black.bold(
        '\n [STEP 4/5] GIT WORKFLOW & PULL REQUEST CREATION '
      )
    );

    const commitMsg = `fix(deps): bump dependencies and remediate breaking changes [${targetPackages
      .map((p) => p.name)
      .join(', ')}]`;
    const filesToCommit = [
      'package.json',
      'package-lock.json',
      ...Array.from(healedFiles),
    ];

    await this.git.commitChanges(commitMsg, filesToCommit);
    console.log(
      `✔ Committed remediated files to ${chalk.blue(branchName)}: "${commitMsg}"`
    );

    console.log(`Opening Pull Request with comprehensive DevSecOps report...`);
    const prResult = await this.git.createOrSimulatePR({
      packages: packageBumps,
      branchName,
      breakingChangeAnalysis: analyses.join('\n\n'),
      explanation: explanations.join('\n\n'),
      testEvidence: testResult.stdout || '✔ All tests passed',
      remediatedFiles: Array.from(healedFiles),
    });

    // -------------------------------------------------------------
    // STEP 5: Remediation Pipeline Complete Summary
    // -------------------------------------------------------------
    console.log(
      chalk.bgCyan.black.bold('\n [STEP 5/5] REMEDIATION PIPELINE COMPLETE ')
    );
    console.log(chalk.bold('\n📊 Audit Report:'));
    console.log(`   • Target Repository    : ${chalk.yellow(this.targetDir)}`);
    console.log(`   • Dependencies Remediated:`);
    for (const b of packageBumps) {
      console.log(
        `     - ${chalk.bold(b.name)}: ${chalk.red(b.oldVersion)} ➔ ${chalk.green(
          b.newVersion
        )}`
      );
    }
    console.log(
      `   • Healing Loops Taken  : ${chalk.green(`${attempt} / ${maxAttempts}`)}`
    );
    console.log(`   • Git Branch           : ${chalk.blue(branchName)}`);
    console.log(`   • PR Mode              : ${chalk.cyan(prResult.mode)}`);
    console.log(
      `   • Pull Request URL     : ${chalk.bold.green(prResult.pullRequestUrl)}`
    );

    console.log(
      chalk.green.bold(
        '\n✨ Hefaetus successfully resolved all breaking dependency upgrades autonomously!'
      )
    );

    return {
      success: true,
      targetDir: this.targetDir,
      branchName,
      packagesRemediated: packageBumps,
      healingAttemptsTaken: attempt,
      remediatedFiles: Array.from(healedFiles),
      prResult,
    };
  }
}
