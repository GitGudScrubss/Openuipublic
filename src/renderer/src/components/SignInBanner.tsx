import { useAuth } from '../context/AuthContext'

/**
 * Slim prompt shown at the top of the chat interface for returning users who
 * have completed onboarding but are signed out. Renders nothing while a real
 * (non-anonymous) user is signed in — onboarding requires sign-in, so brand-new
 * users never see this.
 */
export default function SignInBanner(): JSX.Element | null {
  const { isAnonymous } = useAuth()
  if (!isAnonymous) return null

  return (
    <div className="signin-banner">
      <span className="signin-banner-text">Sign in to sync your plan &amp; preferences</span>
      <button className="signin-banner-btn" onClick={() => window.openui.login()}>
        Sign in
      </button>
    </div>
  )
}
