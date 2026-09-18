# 🔥 Hefaetus Remediator

> **Autonomous Self-Healing DevSecOps Agent for Breaking Dependency Upgrades**

Hefaetus is an autonomous security agent that upgrades deprecated and vulnerable dependencies, executes test suites inside an isolated container sandbox, captures breaking change stack traces, and leverages LLMs (Free Google Gemini, OpenAI GPT-4o, or Anthropic Claude) in a self-healing loop to refactor call-sites, verify 100% test pass rates, and open production-ready Pull Requests.

---

## 🚀 3 Ways to Use Hefaetus Across Any Repository

### 1️⃣ Option A: Official GitHub Action (`uses:`) ⭐ *Recommended*

In **any repository**, add `.github/workflows/hefaetus.yml`:

```yaml
name: 🛡️ Autonomous Dependency Remediation

on:
  schedule:
    - cron: '0 2 * * 1' # Runs weekly on Monday
  workflow_dispatch:   # Allows manual trigger

jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - name: 📥 Checkout Repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: 🔥 Run Hefaetus
        uses: hefaetus/hefaetus-remediator@main
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
          packages: 'uuid@^9.0.0,glob@^10.3.10,rimraf@^5.0.5'
```

---

### 2️⃣ Option B: Reusable Workflow (`workflow_call`)

In **any repository**, add `.github/workflows/remediate.yml`:

```yaml
name: 🛡️ Autonomous Remediation

on:
  workflow_dispatch:

jobs:
  heal:
    uses: hefaetus/hefaetus-remediator/.github/workflows/remediate.yml@main
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      GH_PAT: ${{ secrets.GH_PAT }}
    with:
      packages: 'uuid@^9.0.0,glob@^10.3.10'
```

---

### 3️⃣ Option C: NPM CLI (`npx`) for Any CI & Local Dev

Works in **any terminal** or **any CI/CD system** (GitLab CI, CircleCI, Bitbucket Pipelines, Jenkins):

```bash
# Run in the root of your project
export GEMINI_API_KEY="your-gemini-key"
export GITHUB_TOKEN="your-github-token"

npx hefaetus-remediator --packages "uuid@^9.0.0,glob@^10.3.10"
```

#### CLI Flags:
| Flag | Description | Default |
| :--- | :--- | :--- |
| `-d, --target-dir <path>` | Path to target project | `.` (current directory) |
| `-p, --packages <list>` | Comma-separated dependencies | Auto-detect |
| `-l, --max-loops <num>` | Maximum self-healing attempts | `6` |
| `-t, --test-command <cmd>` | Test command to run | `npm test` |
| `-b, --branch <name>` | Feature branch name | `fix/hefaetus-autonomous-dependency-remediation` |

---

## ⚙️ Configuration & Secrets

### Supported LLM Providers
- **Google Gemini (Default)**: Free tier supported via Google AI Studio (`GEMINI_API_KEY`). Includes automatic 503 high-demand retry with exponential backoff and model auto-fallback.
- **OpenAI**: GPT-4o (`OPENAI_API_KEY`).
- **Anthropic**: Claude 3.5 Sonnet (`ANTHROPIC_API_KEY`).
- **Deterministic Engine**: Built-in offline fallback for local demonstrations.

### GitHub Permissions Note
If using the default `GITHUB_TOKEN` to create PRs, enable this one-time setting in the target repo:
**Settings** ➔ **Actions** ➔ **General** ➔ **Workflow permissions** ➔ Check **"Allow GitHub Actions to create and approve pull requests"**.  
*(Alternatively, supply a Personal Access Token as secret `GH_PAT`).*

---

## 📜 License
MIT © Hefaetus Agent
