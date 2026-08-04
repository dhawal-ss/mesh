import { expect, test } from '@playwright/test'

test('explicit LAN VoiceEngine module loads in a browser runtime', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    try {
      // This source module and its SimplePeer graph are reachable only from
      // the explicit LAN Playwright project and server.
      const module = await import('/src/lib/voice-engine.ts')
      const engine = new module.VoiceEngine('e2e-community', 'e2e-voice')
      engine.initForTesting('alice')
      engine.applySessionSnapshot({
        communityId: 'e2e-community',
        channelId: 'e2e-voice',
        sessionEpoch: 1,
        memberCount: 2,
        members: [
          { publicKey: 'alice', isLocal: true },
          { publicKey: 'bob', isLocal: false },
        ],
        relay: {
          relayRequired: false,
          relayCandidatePublicKey: null,
        },
        updatedAt: new Date().toISOString(),
      })
      await engine.destroy()
      return { loaded: true, error: null }
    } catch (error) {
      return {
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  expect(result.error).toBeNull()
  expect(result.loaded).toBe(true)
})
