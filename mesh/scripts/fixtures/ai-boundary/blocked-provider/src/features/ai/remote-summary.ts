/**
 * @mesh-ai-module
 * @mesh-ai-local-only
 * @mesh-ai-feature-gate: remote-summary
 * @mesh-ai-resource-disclosure
 * @mesh-ai-no-auto-download
 */
import OpenAI from 'openai'

export async function summarizeRemotely(): Promise<Response> {
  void OpenAI
  return fetch('https://api.openai.com/v1/responses')
}
