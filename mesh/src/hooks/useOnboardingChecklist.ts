import { useEffect, useMemo } from 'react'

import {
  completeStepsFromFacts,
  deriveOnboardingSteps,
  type OnboardingChecklistFacts,
  type OnboardingChecklistStep,
} from '../lib/onboarding-checklist'
import { useChannelStore } from '../store/channels'
import { useCommunityStore } from '../store/communities'
import { useDraftStore } from '../store/drafts'
import { useIdentityStore } from '../store/identity'
import { useMessageStore } from '../store/messages'
import { useOnboardingChecklistStore } from '../store/onboarding-checklist'

export interface OnboardingChecklistView {
  /**
   * This account has a checklist in play: not hidden, and derived from state
   * that has finished arriving. `CommunityChecklist` owns the last frame, since
   * a list that has just been finished stays on screen briefly and a list that
   * was already finished when it mounted never appears.
   */
  active: boolean
  steps: OnboardingChecklistStep[]
  collapsed: boolean
  /**
   * Every step is done, so there is nothing left for the section to show and
   * nothing a preference can bring back. Independent of `active`: the settings
   * control that offers the list needs to know this even where no room is open,
   * or it would offer to show something that cannot appear.
   */
  finished: boolean
}

/**
 * Derives the newcomer checklist from state Mesh already holds and records what
 * it sees.
 *
 * The `settled` gate is the part that matters. Facts arrive over a few hundred
 * milliseconds after a cold start: an established account has authored plenty
 * of messages, but `hasAuthoredMessage` is false until the open room's timeline
 * loads, and its profile picture is unknown until the identity does. Deriving
 * before then would show a finished checklist as unfinished, so somebody who
 * has used Mesh for months would watch a list of first steps appear and then
 * complete itself. Waiting for those two reads costs a newcomer nothing: their
 * checklist has always-incomplete steps either way.
 */
export function useOnboardingChecklist(): OnboardingChecklistView {
  const hydrated = useOnboardingChecklistStore((state) => state.hydrated)
  const reached = useOnboardingChecklistStore((state) => state.reached)
  const dismissed = useOnboardingChecklistStore((state) => state.dismissed)
  const collapsed = useOnboardingChecklistStore((state) => state.collapsed)
  const observe = useOnboardingChecklistStore((state) => state.observe)

  const identityLoaded = useIdentityStore((state) => state.identity !== null)
  const hasProfilePicture = useIdentityStore((state) => Boolean(state.identity?.avatarUrl))
  const joinedCommunity = useCommunityStore((state) => state.communityOrder.length > 0)
  const activeChannelId = useChannelStore((state) => state.activeChannelId)
  /*
   * A room's cache entry exists once it has been read, including when the read
   * returned nothing, which separates "empty room" from "not read yet". This
   * reads `messages` and not `messageOrder` on purpose: an empty room's order is
   * equal to the absent default, so the store keeps the key out of
   * `messageOrder` entirely and a newcomer's first empty room would look like a
   * room that never finished loading.
   */
  const timelineLoaded = useMessageStore((state) =>
    activeChannelId === null || state.messages[activeChannelId] !== undefined,
  )
  const hasAuthoredMessage = useMessageStore((state) => state.hasAuthoredMessage)
  // Drafts are deleted when they become empty, so any entry is real content.
  const hasDraft = useDraftStore((state) => Object.keys(state.drafts).length > 0)

  const settled = hydrated && identityLoaded && timelineLoaded

  const facts = useMemo<OnboardingChecklistFacts>(() => ({
    signedIn: identityLoaded,
    joinedCommunity,
    openedRoom: activeChannelId !== null,
    startedMessage: hasDraft || hasAuthoredMessage,
    hasProfilePicture,
  }), [
    activeChannelId,
    hasAuthoredMessage,
    hasDraft,
    hasProfilePicture,
    identityLoaded,
    joinedCommunity,
  ])

  const steps = useMemo(() => deriveOnboardingSteps(facts, reached), [facts, reached])

  useEffect(() => {
    if (!settled) return
    observe(completeStepsFromFacts(facts))
  }, [facts, observe, settled])

  return {
    active: settled && !dismissed,
    steps,
    collapsed,
    finished: steps.every((step) => step.complete),
  }
}
