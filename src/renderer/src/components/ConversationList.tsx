import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../env'
import { useAuth } from '../context/AuthContext'

interface Props {
  onSelect: (id: string) => void
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function ConversationList({ onSelect }: Props): JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) {
      setConversations([])
      setLoading(false)
      return
    }
    window.openui
      .getConversations()
      .then((list) => setConversations(list))
      .catch(() => setConversations([]))
      .finally(() => setLoading(false))
  }, [user])

  if (loading) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 11, color: '#aeaeb2', fontFamily: '-apple-system, sans-serif' }}>
        Loading…
      </div>
    )
  }

  if (!conversations.length) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 11, color: '#aeaeb2', fontFamily: '-apple-system, sans-serif' }}>
        No conversations yet.
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 240,
        overflowY: 'auto'
      }}
    >
      {conversations.map((conv) => (
        <button
          key={conv.id}
          onClick={() => onSelect(conv.id)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'none',
            border: 'none',
            textAlign: 'left',
            padding: '8px 16px',
            cursor: 'pointer',
            borderRadius: 8,
            transition: 'background 0.12s'
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.04)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'none'
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: '#1c1c1e',
              fontFamily: '-apple-system, sans-serif',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 180
            }}
          >
            {conv.title}
          </span>
          <span style={{ fontSize: 10, color: '#aeaeb2', flexShrink: 0, marginLeft: 8, fontFamily: '-apple-system, sans-serif' }}>
            {formatDate(conv.created_at)}
          </span>
        </button>
      ))}
    </div>
  )
}
