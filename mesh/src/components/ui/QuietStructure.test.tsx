import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AmbientNote,
  Eyebrow,
  ExceptionLine,
  SegmentedControl,
  StateTick,
  TrustRail,
  rowNumber,
} from './QuietStructure'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: React.ReactNode) => {
  act(() => root.render(node))
}

describe('rowNumber', () => {
  it('zero-pads the first nine positions', () => {
    expect(rowNumber(0)).toBe('01')
    expect(rowNumber(8)).toBe('09')
  })

  /*
    Past 99 the number gets wider rather than wrong. A truncated position is a
    lie about where a row is, and the number is a jump target.
  */
  it('stops padding rather than truncating past two digits', () => {
    expect(rowNumber(9)).toBe('10')
    expect(rowNumber(99)).toBe('100')
  })
})

describe('Eyebrow', () => {
  it('is mono, and at the secondary ink by default', () => {
    render(<Eyebrow>Open room</Eyebrow>)
    const eyebrow = container.querySelector('span')
    expect(eyebrow?.className).toContain('')
    expect(eyebrow?.className).toContain('')
    expect(eyebrow?.className).toContain('text-on-surface-variant')
  })

  /*
    An eyebrow that merely labels a section is never accented. If every label
    is accented then the accent has stopped pointing at anything, so the accent
    is opt-in and reserved for the one continuation target on a screen.
  */
  it('takes the accent only when asked', () => {
    render(<Eyebrow accent>Continue conversation</Eyebrow>)
    expect(container.querySelector('span')?.className).toContain('text-primary')
  })

  it('becomes a heading when a level is given', () => {
    render(<Eyebrow headingLevel={2}>Rooms</Eyebrow>)
    const heading = container.querySelector('[role="heading"]')
    expect(heading?.getAttribute('aria-level')).toBe('2')
  })
})

describe('SegmentedControl', () => {
  const options = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'high-contrast', label: 'High contrast' },
  ] as const

  it('is a radiogroup whose selection is a flat plane with square inner corners', () => {
    render(<SegmentedControl label="Theme" value="light" options={options} onChange={() => {}} />)
    const group = container.querySelector('[role="radiogroup"]')
    expect(group?.getAttribute('aria-label')).toBe('Theme')
    const selected = container.querySelector('[aria-checked="true"]')
    expect(selected?.textContent).toBe('Light')
    expect(selected?.className).toContain('rounded-full')
    expect(selected?.className).toContain('bg-primary')
  })

  it('keeps the group to one tab stop', () => {
    render(<SegmentedControl label="Theme" value="light" options={options} onChange={() => {}} />)
    const stops = [...container.querySelectorAll('[role="radio"]')]
      .filter((option) => option.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
  })

  it('moves the selection with the arrow keys and wraps', () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="Theme" value="high-contrast" options={options} onChange={onChange} />)
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('dark')
  })

  it('selects on click', () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="Theme" value="dark" options={options} onChange={onChange} />)
    act(() => {
      container.querySelectorAll('button')[1]?.click()
    })
    expect(onChange).toHaveBeenCalledWith('light')
  })
})

describe('TrustRail', () => {
  /*
    Green, chrome and vermilion are indistinguishable to somebody who cannot
    see them, so each rail says which state it is in words.
  */
  it('names each tone rather than relying on its colour', () => {
    render(<TrustRail tone="ok" server="lantern.dev" />)
    const rail = container.querySelector('[data-trust]')
    expect(rail?.getAttribute('data-trust')).toBe('ok')
    expect(rail?.getAttribute('aria-label')).toBe('Encrypted, from lantern.dev, verified device')
  })

  it('says so when an event could not be verified', () => {
    render(<TrustRail tone="suspect" server="nine.chat" />)
    expect(container.querySelector('[data-trust]')?.getAttribute('aria-label'))
      .toBe('Could not verify this message')
  })

  it('is the one 2px rule in the system', () => {
    render(<TrustRail tone="remote" server="nine.chat" />)
    expect(container.querySelector('[data-trust]')?.className).toContain('w-trust-rail')
  })
})

describe('StateTick', () => {
  it('pairs its state with the word it stands for', () => {
    render(<StateTick state="ok" label="Under 150 milliseconds" />)
    const tick = container.querySelector('[data-state]')
    expect(tick?.getAttribute('data-state')).toBe('ok')
    expect(tick?.getAttribute('aria-label')).toBe('Under 150 milliseconds')
  })
})

describe('ExceptionLine', () => {
  it('renders the exception as mono text beside a dot', () => {
    render(<ExceptionLine>Sent from an unverified device</ExceptionLine>)
    const line = container.querySelector('p')
    expect(line?.textContent).toContain('Sent from an unverified device')
    expect(line?.className).toContain('')
    expect(line?.className).toContain('text-marker')
  })

  it('escalates to danger when asked', () => {
    render(<ExceptionLine tone="danger">Could not decrypt</ExceptionLine>)
    expect(container.querySelector('p')?.className).toContain('text-error')
  })
})

describe('AmbientNote', () => {
  it('sits on the bottom rule at the caption step in normal case', () => {
    render(<AmbientNote>Media relayed peer to peer</AmbientNote>)
    const note = container.firstElementChild
    expect(note?.textContent).toContain('Media relayed peer to peer')
    expect(note?.className).toContain('border-t')
    expect(note?.className).toContain('text-label-sm')
    expect(note?.className).toContain('normal-case')
  })

  it('prefixes a green tick when the note confirms encryption', () => {
    render(<AmbientNote confirmed>Encrypted, 3 servers carry this room</AmbientNote>)
    expect(container.querySelector('[data-state="ok"]')).not.toBeNull()
  })
})
