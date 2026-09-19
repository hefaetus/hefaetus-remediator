import { OpenAI } from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import chalk from 'chalk';

export interface RemediationInput {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  filePath: string;
  fileContent: string;
  errorStackTrace: string;
  testOutput: string;
  attempt: number;
  maxAttempts: number;
}

export interface RemediationOutput {
  patchedCode: string;
  explanation: string;
  breakingChangeAnalysis: string;
  rawResponse?: string;
}

function isValidKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  if (trimmed.length < 15) return false;
  if (trimmed.startsWith('your_') || trimmed.includes('placeholder')) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: any): boolean {
  const status = err?.status || err?.error?.code || err?.code;
  const msg = `${err?.message || ''} ${JSON.stringify(err) || ''}`.toLowerCase();
  if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) {
    return true;
  }
  if (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('spikes in demand') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('try again later')
  ) {
    return true;
  }
  return false;
}

export class RemediationLLMClient {
  private provider: 'openai' | 'anthropic' | 'gemini' | 'mock';
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private geminiClient?: GoogleGenAI;
  private model: string;

  constructor() {
    const forcedProvider = process.env.LLM_PROVIDER?.toLowerCase();
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const hasGemini = isValidKey(geminiKey);
    const hasOpenAI = isValidKey(process.env.OPENAI_API_KEY);
    const hasAnthropic = isValidKey(process.env.ANTHROPIC_API_KEY);

    if ((forcedProvider === 'gemini' || forcedProvider === 'google') && hasGemini) {
      this.provider = 'gemini';
      this.geminiClient = new GoogleGenAI({ apiKey: geminiKey });
      this.model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    } else if (forcedProvider === 'openai' && hasOpenAI) {
      this.provider = 'openai';
      this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    } else if (forcedProvider === 'anthropic' && hasAnthropic) {
      this.provider = 'anthropic';
      this.anthropicClient = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    } else if (hasGemini) {
      // Free Tier Default if Gemini API key is provided
      this.provider = 'gemini';
      this.geminiClient = new GoogleGenAI({ apiKey: geminiKey });
      this.model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
    } else if (hasOpenAI) {
      this.provider = 'openai';
      this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    } else if (hasAnthropic) {
      this.provider = 'anthropic';
      this.anthropicClient = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    } else {
      // Offline / Demo Fallback Mode
      this.provider = 'mock';
      this.model = 'hefaetus-deterministic-engine';
    }
  }

  public getProviderInfo(): { provider: string; model: string } {
    return {
      provider: this.provider,
      model: this.model,
    };
  }

  /**
   * Cleans code fenced blocks if the LLM wrapped code in ```javascript or ``` blocks.
   */
  private extractCleanCode(rawText: string): string {
    const codeBlockMatch = rawText.match(
      /```(?:javascript|js)?\s*([\s\S]*?)\s*```/i
    );
    if (codeBlockMatch && codeBlockMatch[1]) {
      return codeBlockMatch[1].trim();
    }
    return rawText.trim();
  }

  /**
   * Returns deterministic fallback remediation for offline / demo mode.
   */
  private getDeterministicPatch(input: RemediationInput): RemediationOutput {
    if (input.packageName === 'glob' || input.filePath.includes('fileFinder')) {
      const globPatched = `const { glob } = require('glob');

async function findFiles(pattern) {
  return glob(pattern);
}

module.exports = { findFiles };
`;
      return {
        patchedCode: globPatched,
        explanation:
          "Migrated legacy callback-based 'glob(pattern, cb)' to modern Promise-based named export '{ glob }' from 'glob' v10.",
        breakingChangeAnalysis:
          "In glob v10+, the default export is no longer a callback function. Calling glob directly throws 'TypeError: glob is not a function'. Modern glob exports an async Promise-based function { glob }.",
        rawResponse: 'DETERMINISTIC_ENGINE_OUTPUT',
      };
    }

    if (input.packageName === 'rimraf' || input.filePath.includes('fileCleaner')) {
      const rimrafPatched = `const { rimraf } = require('rimraf');

async function deletePath(targetPath) {
  return rimraf(targetPath);
}

module.exports = { deletePath };
`;
      return {
        patchedCode: rimrafPatched,
        explanation:
          "Migrated legacy callback-based 'rimraf(path, cb)' to modern Promise-based named export '{ rimraf }' from 'rimraf' v5.",
        breakingChangeAnalysis:
          "In rimraf v4/v5+, the default function signature was removed in favor of named exports. Calling rimraf directly throws 'TypeError: rimraf is not a function'. The modern API provides { rimraf } returning a native Promise.",
        rawResponse: 'DETERMINISTIC_ENGINE_OUTPUT',
      };
    }

    const mockPatched = `const { v4: uuidv4 } = require('uuid');

function generateId() {
  return uuidv4();
}

module.exports = { generateId };
`;

    return {
      patchedCode: mockPatched,
      explanation:
        "Updated deprecated deep require path 'uuid/v4' to named ES/CJS import '{ v4: uuidv4 }' from root 'uuid' package.",
      breakingChangeAnalysis:
        "In uuid v7, v8, and v9, deep require paths such as require('uuid/v4') were permanently removed in compliance with modern package exports encapsulation. The recommended import pattern is const { v4: uuidv4 } = require('uuid').",
      rawResponse: 'DETERMINISTIC_ENGINE_OUTPUT',
    };
  }

  /**
   * Main remediation method: sends prompt to LLM and returns the patched file code and analysis.
   */
  public async generatePatch(
    input: RemediationInput
  ): Promise<RemediationOutput> {
    const systemPrompt = `You are Hefaetus, an expert DevSecOps and Platform Engineering Autonomous Remediation Agent.
Your role is to fix breaking changes introduced when upgrading Node.js dependencies to address security vulnerabilities.

CRITICAL INSTRUCTIONS:
1. You will be provided with:
   - Target dependency name and version bump (e.g., uuid 3.4.0 -> ^9.0.0).
   - Source code file path and current content.
   - The test failure stdout/stderr stack trace.
   - Current remediation attempt number.
2. Analyze why the breaking change occurred in the library upgrade.
3. Refactor the source code to be fully compliant with the modern dependency API while maintaining 100% functional parity and backwards compatibility for callers.
4. Output your response in valid JSON matching this schema:
{
  "breakingChangeAnalysis": "Detailed technical analysis of why the library broke (e.g., removal of deep require/submodule exports in modern uuid)",
  "explanation": "Concise summary of the code refactor performed",
  "patchedCode": "The complete, production-ready replacement code for the file"
}
Ensure the patchedCode field contains ONLY the raw JavaScript/TypeScript code (no markdown backticks inside the JSON string).`;

    const userPrompt = `Target Package: ${input.packageName} (${input.oldVersion} -> ${input.newVersion})
File to refactor: ${input.filePath}
Remediation Attempt: ${input.attempt} / ${input.maxAttempts}

CURRENT FILE CONTENT (${input.filePath}):
\`\`\`javascript
${input.fileContent}
\`\`\`

TEST FAILURE OUTPUT & STACK TRACE:
\`\`\`text
${input.errorStackTrace || input.testOutput}
\`\`\`

Please analyze the failure and generate the patched file content.`;

    // 1. Google Gemini (Supports Free Tier with Google AI Studio)
    if (this.provider === 'gemini' && this.geminiClient) {
      const candidateModels = [
        this.model,
        'gemini-3.6-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
      ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

      const MAX_RETRIES_PER_MODEL = 3;
      let lastGeminiError: any = null;

      for (const modelName of candidateModels) {
        let attempt = 0;

        while (attempt < MAX_RETRIES_PER_MODEL) {
          attempt++;
          try {
            const response = await this.geminiClient.models.generateContent({
              model: modelName,
              contents: userPrompt,
              config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0.1,
              },
            });

            const rawContent = response.text || '{}';
            try {
              const parsed = JSON.parse(rawContent);
              return {
                patchedCode: this.extractCleanCode(parsed.patchedCode || ''),
                explanation:
                  parsed.explanation ||
                  'Refactored import statement for upgraded dependency.',
                breakingChangeAnalysis:
                  parsed.breakingChangeAnalysis ||
                  `Breaking change occurred in ${input.packageName} upgrade from ${input.oldVersion} to ${input.newVersion}.`,
                rawResponse: rawContent,
              };
            } catch {
              return {
                patchedCode: this.extractCleanCode(rawContent),
                explanation:
                  'Extracted refactored source directly from Gemini response.',
                breakingChangeAnalysis: `API breaking change during ${input.packageName} upgrade.`,
                rawResponse: rawContent,
              };
            }
          } catch (err: any) {
            lastGeminiError = err;
            const isNotFound =
              err?.status === 404 ||
              (err?.message &&
                (err.message.includes('NOT_FOUND') ||
                  err.message.includes('no longer available') ||
                  err.message.includes('404')));

            if (isNotFound) {
              console.warn(
                chalk.yellow(`[Gemini] Model ${modelName} returned 404. Auto-trying next candidate...`)
              );
              break;
            }

            if (isRetryableError(err)) {
              if (attempt < MAX_RETRIES_PER_MODEL) {
                const backoffMs = attempt * 2000 + Math.floor(Math.random() * 1000);
                console.warn(
                  chalk.yellow(
                    `[Gemini] Model ${modelName} is experiencing high demand (503/429). Retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})...`
                  )
                );
                await sleep(backoffMs);
                continue;
              } else {
                console.warn(
                  chalk.yellow(
                    `[Gemini] Model ${modelName} exhausted ${MAX_RETRIES_PER_MODEL} retries due to high demand. Auto-trying next candidate model...`
                  )
                );
                break;
              }
            }

            console.warn(
              chalk.yellow(
                `[Gemini] Model ${modelName} encountered error (${err.message || err}). Trying next candidate...`
              )
            );
            break;
          }
        }
      }

      console.warn(
        chalk.yellow(
          `\n⚠️  [LLM Warning] All Google Gemini candidate models exhausted or temporarily unavailable (${lastGeminiError?.message || 'High Demand'}). Falling back to Hefaetus deterministic engine for live demonstration.`
        )
      );
      return this.getDeterministicPatch(input);
    }

    // 2. OpenAI GPT-4o
    if (this.provider === 'openai' && this.openaiClient) {
      let attempt = 0;
      const MAX_RETRIES = 3;
      while (attempt < MAX_RETRIES) {
        attempt++;
        try {
          const response = await this.openaiClient.chat.completions.create({
            model: this.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          });

          const rawContent = response.choices[0]?.message?.content || '{}';
          try {
            const parsed = JSON.parse(rawContent);
            return {
              patchedCode: this.extractCleanCode(parsed.patchedCode || ''),
              explanation:
                parsed.explanation ||
                'Refactored import statement for upgraded dependency.',
              breakingChangeAnalysis:
                parsed.breakingChangeAnalysis ||
                `Breaking change occurred in ${input.packageName} upgrade from ${input.oldVersion} to ${input.newVersion}.`,
              rawResponse: rawContent,
            };
          } catch {
            return {
              patchedCode: this.extractCleanCode(rawContent),
              explanation:
                'Extracted refactored source directly from LLM response.',
              breakingChangeAnalysis: `API breaking change during ${input.packageName} upgrade.`,
              rawResponse: rawContent,
            };
          }
        } catch (err: any) {
          if (isRetryableError(err) && attempt < MAX_RETRIES) {
            const backoffMs = attempt * 2000;
            console.warn(
              chalk.yellow(`[OpenAI] Rate limited or unavailable. Retrying in ${backoffMs / 1000}s...`)
            );
            await sleep(backoffMs);
            continue;
          }
          console.warn(
            chalk.yellow(
              `\n⚠️  [LLM Warning] OpenAI API request failed (${err.message}). Falling back to Hefaetus deterministic engine for live demonstration.`
            )
          );
          return this.getDeterministicPatch(input);
        }
      }
    }

    // 3. Anthropic Claude 3.5 Sonnet
    if (this.provider === 'anthropic' && this.anthropicClient) {
      let attempt = 0;
      const MAX_RETRIES = 3;
      while (attempt < MAX_RETRIES) {
        attempt++;
        try {
          const response = await this.anthropicClient.messages.create({
            model: this.model,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          });

          const textBlock = response.content.find((c) => c.type === 'text');
          const rawContent = textBlock?.type === 'text' ? textBlock.text : '';

          try {
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                patchedCode: this.extractCleanCode(parsed.patchedCode || ''),
                explanation:
                  parsed.explanation ||
                  'Refactored import for dependency upgrade.',
                breakingChangeAnalysis:
                  parsed.breakingChangeAnalysis ||
                  `Breaking change identified during ${input.packageName} migration.`,
                rawResponse: rawContent,
              };
            }
          } catch {
            // Fallback if not valid JSON
          }

          return {
            patchedCode: this.extractCleanCode(rawContent),
            explanation: 'Refactored call-site using Anthropic Claude.',
            breakingChangeAnalysis: `Upgraded ${input.packageName} to modern API.`,
            rawResponse: rawContent,
          };
        } catch (err: any) {
          if (isRetryableError(err) && attempt < MAX_RETRIES) {
            const backoffMs = attempt * 2000;
            console.warn(
              chalk.yellow(`[Anthropic] Rate limited or unavailable. Retrying in ${backoffMs / 1000}s...`)
            );
            await sleep(backoffMs);
            continue;
          }
          console.warn(
            chalk.yellow(
              `\n⚠️  [LLM Warning] Anthropic API request failed (${err.message}). Falling back to Hefaetus deterministic engine for live demonstration.`
            )
          );
          return this.getDeterministicPatch(input);
        }
      }
    }

    // 4. Offline / Deterministic Fallback Mode
    return this.getDeterministicPatch(input);
  }
}
