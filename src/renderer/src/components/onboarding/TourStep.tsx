import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useOnboardingAnimations } from '../../hooks/useOnboardingAnimations'

interface Props {
  /** Advance to the next wizard step (fired from the last card's "Next"). */
  onNext: () => void
  /** Jump straight to the final step. */
  onSkip: () => void
}

interface Card {
  title: string
  example: string
  subtitle: string
}

const CARDS: ReadonlyArray<Card> = [
  {
    title: 'Control your computer',
    example: 'Open Spotify and play my Discover Weekly',
    subtitle: 'Open apps, search files, manage your calendar — all by asking.'
  },
  {
    title: 'See your screen',
    example: 'Click the blue Submit button',
    subtitle: 'OpenUI can see and interact with anything on your screen.'
  },
  {
    title: 'Always available',
    example: 'Just click the icon or press a hotkey',
    subtitle: 'Living in your menu bar, always one click away.'
  }
]

const CARD_ICONS = [
  // Computer / cursor
  <svg key="cursor" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="4" y="6" width="40" height="28" rx="4" stroke="#1c1c1e" strokeWidth="2" />
    <path d="M16 40h16M24 34v6" stroke="#1c1c1e" strokeWidth="2" strokeLinecap="round" />
    <path d="M18 16v14l4-4 3 6 2-1-3-6 5-1z" stroke="#1c1c1e" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
  </svg>,
  // Eye
  <svg key="eye" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <ellipse cx="24" cy="24" rx="19" ry="11" stroke="#1c1c1e" strokeWidth="2" />
    <circle cx="24" cy="24" r="5" stroke="#1c1c1e" strokeWidth="2" />
    <circle cx="24" cy="24" r="2" fill="#1c1c1e" />
  </svg>,
  // Menu-bar indicator
  <svg key="menubar" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="4" y="8" width="40" height="8" rx="2" stroke="#1c1c1e" strokeWidth="2" />
    <circle cx="38" cy="12" r="2" fill="#1c1c1e" />
    <circle cx="31" cy="12" r="2" fill="#1c1c1e" />
    <rect x="12" y="24" width="24" height="18" rx="3" stroke="#1c1c1e" strokeWidth="2" />
    <path d="M18 33h12M18 29h8" stroke="#1c1c1e" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
]

/**
 * Step 3 — a swipeable three-card tour of what OpenUI can do. Cards slide
 * horizontally; their inner elements stagger in. "Next" advances through the
 * cards and, on the last one, advances the wizard. "Skip" jumps to the end.
 */
export default function TourStep({ onNext, onSkip }: Props): JSX.Element {
  const { animateStagger } = useOnboardingAnimations()
  const [index, setIndex] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const transitioning = useRef(false)

  // Slide the active card in from the right and stagger its contents.
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    gsap.fromTo(
      card,
      { x: 30, opacity: 0 },
      { x: 0, opacity: 1, duration: 0.4, ease: 'power3.out', overwrite: 'auto' }
    )
    animateStagger(card.querySelectorAll<HTMLElement>('.ob-tour-el'))
  }, [index, animateStagger])

  const isLast = index >= CARDS.length - 1

  const handleNext = (): void => {
    if (transitioning.current) return
    if (isLast) {
      onNext()
      return
    }
    const card = cardRef.current
    if (!card) {
      setIndex((i) => i + 1)
      return
    }
    transitioning.current = true
    gsap.to(card, {
      x: -30,
      opacity: 0,
      duration: 0.22,
      ease: 'power2.in',
      overwrite: 'auto',
      onComplete: () => {
        transitioning.current = false
        setIndex((i) => i + 1)
      }
    })
  }

  const card = CARDS[index]

  return (
    <div className="ob-tour">
      <h1 className="ob-title" style={{ textAlign: 'center', marginBottom: 18 }}>
        What can OpenUI do?
      </h1>

      <div ref={cardRef} className="ob-tour-card">
        <div className="ob-tour-illustration ob-tour-el">
          {CARD_ICONS[index]}
        </div>
        <div className="ob-tour-title ob-tour-el">{card.title}</div>
        <div className="ob-bubble ob-tour-el">{card.example}</div>
        <div className="ob-tour-sub ob-tour-el">{card.subtitle}</div>
      </div>

      <div className="ob-tour-dots" style={{ marginTop: 18 }}>
        {CARDS.map((c, i) => (
          <span key={c.title} className={`ob-dot${i === index ? ' active' : ''}`} />
        ))}
        <span className="ob-tour-count">
          {index + 1} of {CARDS.length}
        </span>
      </div>

      <div className="ob-tour-actions">
        <button className="ob-btn-ghost" onClick={onSkip}>
          Skip
        </button>
        <button className="ob-btn-primary ob-btn-inline" onClick={handleNext}>
          {isLast ? 'Continue' : 'Next'}&nbsp;&rarr;
        </button>
      </div>
    </div>
  )
}
