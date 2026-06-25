import { useMemo } from 'react'
import gsap from 'gsap'

/**
 * GSAP helpers for the onboarding wizard, mirroring the imperative style of
 * useAssistantAnimations. Steps share a single content container that animates
 * out (fade + slide-down) before the step state swaps, then animates back in
 * (fade + slide-up) once the new step has mounted.
 *
 * All helpers null-guard their target so callers can pass a possibly-null ref
 * without branching, and the exit helpers always invoke `onComplete` (even when
 * the element is missing) so step transitions never stall.
 */

export interface OnboardingAnimations {
  /** Fade + slide-up entrance for the current step's content. */
  animateStepIn: (el: HTMLElement | null) => void
  /** Fade + slide-down exit; runs `onComplete` when the tween finishes. */
  animateStepOut: (el: HTMLElement | null, onComplete: () => void) => void
  /** Scale + fade pop for the Welcome logo. */
  animateLogo: (el: HTMLElement | null) => void
  /** Staggered fade + slide-up for a set of cards/rows. */
  animateStagger: (els: ArrayLike<HTMLElement> | null | undefined) => void
  /** Final exit of the whole wizard before the chat interface takes over. */
  animateWizardOut: (el: HTMLElement | null, onComplete: () => void) => void
}

export function useOnboardingAnimations(): OnboardingAnimations {
  return useMemo<OnboardingAnimations>(
    () => ({
      animateStepIn(el): void {
        if (!el) return
        gsap.fromTo(
          el,
          { opacity: 0, y: 16 },
          { opacity: 1, y: 0, duration: 0.45, ease: 'expo.out', overwrite: 'auto' }
        )
      },

      animateStepOut(el, onComplete): void {
        if (!el) {
          onComplete()
          return
        }
        gsap.to(el, {
          opacity: 0,
          y: 16,
          duration: 0.26,
          ease: 'power2.in',
          overwrite: 'auto',
          onComplete
        })
      },

      animateLogo(el): void {
        if (!el) return
        gsap.fromTo(
          el,
          { opacity: 0, scale: 0.6 },
          { opacity: 1, scale: 1, duration: 0.95, ease: 'elastic.out(1, 0.6)', overwrite: 'auto' }
        )
      },

      animateStagger(els): void {
        if (!els || els.length === 0) return
        gsap.fromTo(
          Array.from(els),
          { opacity: 0, y: 12 },
          {
            opacity: 1,
            y: 0,
            duration: 0.5,
            ease: 'power3.out',
            stagger: 0.09,
            delay: 0.12,
            overwrite: 'auto'
          }
        )
      },

      animateWizardOut(el, onComplete): void {
        if (!el) {
          onComplete()
          return
        }
        gsap.to(el, {
          opacity: 0,
          scale: 0.96,
          y: 12,
          duration: 0.4,
          ease: 'power2.inOut',
          overwrite: 'auto',
          onComplete
        })
      }
    }),
    []
  )
}
