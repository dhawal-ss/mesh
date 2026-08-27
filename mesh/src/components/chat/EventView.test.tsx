import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventView } from './EventView'
import type { Rsvp } from '../../lib/room-shape'

const PLAN = {
  id: '$plan',
  authorDisplayName: 'Maya Chen',
  content: 'Raid night Saturday, 8pm. Bring a healer.',
  timestamp: '2026-08-01T18:00:00.000Z',
}

const NAMES: Record<string, string> = {
  '@maya:mesh.test': 'Maya Chen',
  '@rohan:mesh.test': 'Rohan',
  '@ari:mesh.test': 'Ari',
}

const EMPTY_RSVP: Rsvp = { going: [], maybe: [], cant: [], total: 0 }

describe('EventView', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(overrides: Partial<Parameters<typeof EventView>[0]> = {}) {
    act(() => {
      root.render(
        <EventView
          roomId="!game-night:mesh.test"
          channelName="game-night"
          plan={PLAN}
          rsvp={EMPTY_RSVP}
          memberNames={NAMES}
          myUserId="@taylor:mesh.test"
          onReply={() => {}}
          onOpenPlan={() => {}}
          {...overrides}
        />,
      )
    })
  }

  const buttonByText = (text: string) => Array.from(container.querySelectorAll('button'))
    .find((button) => (button.textContent ?? '').includes(text))

  it('leads with the room name at poster scale and the plan at reading size', () => {
    render()

    const heading = container.querySelector('[data-event-name]')
    expect(heading?.textContent).toContain('game-night')
    expect(heading?.className).toContain('text-display-lg')

    // The plan is somebody's sentence, of no known length. It reads, it does
    // not shout.
    const plan = container.querySelector('[data-event-plan]')
    expect(plan?.textContent).toContain('Bring a healer')
    expect(plan?.className).not.toContain('text-display-lg')
  })

  it('offers the three replies, and says how many people chose each', () => {
    render({
      rsvp: {
        going: ['@maya:mesh.test', '@rohan:mesh.test'],
        maybe: ['@ari:mesh.test'],
        cant: [],
        total: 3,
      },
    })

    expect(buttonByText('Going')?.textContent).toContain('2')
    expect(buttonByText('Maybe')?.textContent).toContain('1')
    expect(buttonByText("Can't")).toBeTruthy()
  })

  it('marks the reply this account already gave, and not with colour alone', () => {
    render({ rsvp: { going: ['@taylor:mesh.test'], maybe: [], cant: [], total: 1 } })

    const going = buttonByText('Going')
    expect(going?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonByText('Maybe')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the reply that was chosen', () => {
    const onReply = vi.fn()
    render({ onReply })

    act(() => {
      buttonByText('Going')?.click()
    })

    expect(onReply).toHaveBeenCalledWith('going')
  })

  it('names who is coming, rather than only counting them', () => {
    render({
      rsvp: { going: ['@maya:mesh.test', '@rohan:mesh.test'], maybe: [], cant: [], total: 2 },
    })

    const roster = container.querySelector('[data-event-roster]')
    expect(roster?.textContent).toContain('Maya Chen')
    expect(roster?.textContent).toContain('Rohan')
  })

  it('explains what to do when no message has been pinned yet', () => {
    render({ plan: null })

    expect(container.textContent).toContain('No plan pinned')
    // Without a plan there is nothing to answer, so it must not ask.
    expect(buttonByText('Going')).toBeFalsy()
  })

  it('opens the plan back in the conversation', () => {
    const onOpenPlan = vi.fn()
    render({ onOpenPlan })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-event-open-plan]')?.click()
    })

    expect(onOpenPlan).toHaveBeenCalledWith('$plan')
  })
})
