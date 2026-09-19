import fs from 'fs';
import path from 'path';

export interface TargetPackageDef {
  name: string;
  targetVersion: string;
  sourceFile?: string;
}

export interface PackageBumpInfo {
  name: string;
  oldVersion: string;
  newVersion: string;
}

// Built-in catalog for demo/outdated packages
export const DEFAULT_DEMO_PACKAGES: TargetPackageDef[] = [
  { name: 'uuid', targetVersion: '^9.0.0', sourceFile: path.join('src', 'idGenerator.js') },
  { name: 'glob', targetVersion: '^10.3.10', sourceFile: path.join('src', 'fileFinder.js') },
  { name: 'rimraf', targetVersion: '^5.0.5', sourceFile: path.join('src', 'fileCleaner.js') },
];

export class DependencyScanner {
  private targetDir: string;

  constructor(targetDir: string) {
    this.targetDir = path.resolve(targetDir);
  }

  /**
   * Attempts to detect outdated dependencies in the target repo via npm outdated.
   */
  public detectOutdatedPackages(): TargetPackageDef[] {
    try {
      const { spawnSync } = require('child_process');
      const execResult = spawnSync('npm', ['outdated', '--json'], {
        cwd: this.targetDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });

      const stdout = (execResult.stdout || '').trim();
      if (!stdout) return [];

      const data = JSON.parse(stdout);
      const outdated: TargetPackageDef[] = [];

      for (const [pkgName, info] of Object.entries<any>(data)) {
        if (info && info.latest) {
          outdated.push({
            name: pkgName,
            targetVersion: `^${info.latest}`,
          });
        }
      }

      return outdated;
    } catch {
      return [];
    }
  }

  /**
   * Resolves which packages need to be upgraded and remediated.
   */
  public resolveTargetPackages(explicitPackages?: string): TargetPackageDef[] {
    // 1. From explicit parameter or environment variable
    const rawInput = explicitPackages || process.env.TARGET_PACKAGES || process.env.PACKAGES;
    if (rawInput && rawInput.trim().length > 0) {
      const items = rawInput.split(',').map((s) => s.trim()).filter(Boolean);
      return items.map((item) => {
        const lastAt = item.lastIndexOf('@');
        if (lastAt > 0) {
          const name = item.substring(0, lastAt);
          const targetVersion = item.substring(lastAt + 1);
          return { name, targetVersion };
        }
        return { name: item, targetVersion: 'latest' };
      });
    }

    // 2. From local config file (.hefaetusrc.json or hefaetus.json) in target repo
    const configCandidates = [
      path.join(this.targetDir, '.hefaetusrc.json'),
      path.join(this.targetDir, 'hefaetus.config.json'),
      path.join(this.targetDir, 'hefaetus.json'),
    ];

    for (const cfgFile of configCandidates) {
      if (fs.existsSync(cfgFile)) {
        try {
          const config = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
          if (Array.isArray(config.packages) && config.packages.length > 0) {
            return config.packages.map((p: any) => {
              if (typeof p === 'string') {
                const lastAt = p.lastIndexOf('@');
                return lastAt > 0
                  ? { name: p.substring(0, lastAt), targetVersion: p.substring(lastAt + 1) }
                  : { name: p, targetVersion: 'latest' };
              }
              return p;
            });
          }
        } catch {
          // ignore malformed config
        }
      }
    }

    // 3. Auto-detect from target manifest (matches demo packages if present)
    const pkgPath = path.join(this.targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
        const matched = DEFAULT_DEMO_PACKAGES.filter((p) => Boolean(deps[p.name]));
        if (matched.length > 0) {
          return matched;
        }
      } catch {
        // ignore
      }
    }

    // 4. Try scanning for outdated packages in the repository
    const detectedOutdated = this.detectOutdatedPackages();
    if (detectedOutdated.length > 0) {
      return detectedOutdated;
    }

    // 5. If explicit demo fallback is allowed via environment variable
    if (process.env.ALLOW_DEMO_FALLBACK === 'true') {
      return DEFAULT_DEMO_PACKAGES;
    }

    // 6. Otherwise fail fast with clear guidance instead of polluting the repository
    throw new Error(
      `[Hefaetus Configuration Error]: No packages specified to remediate, and no outdated dependencies were detected.\n` +
      `Please specify which dependencies to upgrade:\n` +
      `  • In GitHub Action:    with: packages: "package-name@^target-version"\n` +
      `  • In CLI:              hefaetus --packages "package-name@^target-version"\n` +
      `  • In config file:      Add "packages": ["package-name@^target-version"] in .hefaetusrc.json`
    );
  }

  /**
   * Updates package.json with the secure target versions.
   */
  public bumpDependencies(packages: TargetPackageDef[]): {
    packageBumps: PackageBumpInfo[];
    updatedPackageJson: any;
  } {
    const pkgPath = path.join(this.targetDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`Target package.json not found at: ${pkgPath}`);
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkgJson.dependencies = pkgJson.dependencies || {};

    const packageBumps: PackageBumpInfo[] = [];

    for (const targetPkg of packages) {
      const currentVersion =
        pkgJson.dependencies[targetPkg.name] ||
        pkgJson.devDependencies?.[targetPkg.name] ||
        'unknown';

      packageBumps.push({
        name: targetPkg.name,
        oldVersion: currentVersion,
        newVersion: targetPkg.targetVersion,
      });

      // Update dependencies
      if (pkgJson.devDependencies && pkgJson.devDependencies[targetPkg.name]) {
        pkgJson.devDependencies[targetPkg.name] = targetPkg.targetVersion;
      } else {
        pkgJson.dependencies[targetPkg.name] = targetPkg.targetVersion;
      }
    }

    fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');

    return {
      packageBumps,
      updatedPackageJson: pkgJson,
    };
  }
}
