import { exec } from 'child_process';
import path from 'path';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
}

export class SandboxRunner {
  private isDockerAvailable: boolean | null = null;

  private async checkDocker(): Promise<boolean> {
    if (this.isDockerAvailable !== null) {
      return this.isDockerAvailable;
    }
    if (process.env.EXECUTION_MODE === 'local') {
      this.isDockerAvailable = false;
      return false;
    }

    return new Promise((resolve) => {
      exec('docker info', { timeout: 3000 }, (err) => {
        this.isDockerAvailable = !err;
        resolve(!err);
      });
    });
  }

  public async getActiveModeDescription(): Promise<string> {
    const hasDocker = await this.checkDocker();
    if (process.env.EXECUTION_MODE === 'local') {
      return 'Local Execution Engine [Enforced]';
    }
    return hasDocker
      ? 'Docker Container Sandbox'
      : 'Local Execution Engine (Docker sandbox not detected, fallback enabled)';
  }

  private executeLocalCommand(
    command: string,
    cwd: string,
    timeoutMs = 60000
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            CI: 'true',
          },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const exitCode = error ? error.code ?? 1 : 0;
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode,
            durationMs,
            success: exitCode === 0,
          });
        }
      );
    });
  }

  public async runNpmInstall(targetDir: string): Promise<ExecutionResult> {
    return this.executeLocalCommand('npm install', targetDir, 120000);
  }

  public async runNpmTest(
    targetDir: string,
    customCommand = 'npm test'
  ): Promise<ExecutionResult> {
    const hasDocker = await this.checkDocker();

    if (hasDocker) {
      const dockerImage = process.env.SANDBOX_IMAGE || 'node:22-alpine';
      const absPath = path.resolve(targetDir);
      const dockerCmd = `docker run --rm -v "${absPath}:/app" -w /app "${dockerImage}" ${customCommand}`;
      const result = await this.executeLocalCommand(dockerCmd, targetDir, 60000);
      if (result.exitCode === 125 || result.exitCode === 127) {
        // Fallback to local
        return this.executeLocalCommand(customCommand, targetDir, 60000);
      }
      return result;
    }

    return this.executeLocalCommand(customCommand, targetDir, 60000);
  }
}
