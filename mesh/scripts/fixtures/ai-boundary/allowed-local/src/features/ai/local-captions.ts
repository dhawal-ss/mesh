/**
 * @mesh-ai-module
 * @mesh-ai-local-only
 * @mesh-ai-feature-gate: local-captions
 * @mesh-ai-resource-disclosure
 * @mesh-ai-no-auto-download
 */
// Review prose is not executable: import OpenAI from 'openai'; fetch('https://api.openai.com');
// Review prose is not authority: bridge.banUser('fixture member');
export function captionLocally(samples: Float32Array): string {
  return samples.length > 0 ? 'local caption' : ''
}
