import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { videoIdFrom } from './videoId.js';
import { ThemeToggle } from './ThemeToggle.jsx';
import { Room } from './Room.jsx';

// Production uses the same Node origin. Vite proxies these endpoints locally.
const API = import.meta.env.VITE_SOCKET_URL || window.location.origin;

export function App() {
  const [socket, setSocket] = useState(null);
  const [room, setRoom] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('syncspace-theme') || 'dark');
  const [session, setSession] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('syncspace-session'));
    } catch {
      return null;
    }
  });

  const [form, setForm] = useState(() => ({
    username: '',
    roomId: new URLSearchParams(window.location.search).get('room') || '',
    video: '',
  }));
  const [error, setError] = useState('');

  // Synchronize theme to document body and html for seamless styles
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.className = `theme-${theme}`;
  }, [theme]);

  useEffect(() => {
    const s = io(API);
    setSocket(s);
    return () => s.close();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const restore = () => {
      if (!session?.roomId || !session?.sessionToken) return;
      socket.emit('resume_room', session, (data) => {
        if (data?.error) {
          sessionStorage.removeItem('syncspace-session');
          setSession(null);
          setRoom(null);
          setError(data.error);
        } else if (data) {
          setRoom(data);
        }
      });
    };
    socket.on('connect', restore);
    socket.on('action_rejected', ({ message }) => setError(message));
    socket.on('removed_from_room', () => {
      sessionStorage.removeItem('syncspace-session');
      setSession(null);
      setError('You were removed from this watch party.');
      setRoom(null);
    });
    return () => {
      socket.off('connect', restore);
      socket.off('action_rejected');
      socket.off('removed_from_room');
    };
  }, [socket, session]);

  const enterRoom = (data) => {
    setRoom(data);
    const next = { roomId: data.roomId, sessionToken: data.self.sessionToken };
    sessionStorage.setItem('syncspace-session', JSON.stringify(next));
    setSession(next);
  };

  const enter = (mode) => {
    setError('');
    if (!socket?.connected) {
      return setError('Connecting to the watch-party server. Please wait a moment and try again.');
    }
    const username = form.username.trim();
    if (!username) {
      return setError('Please enter a display name to continue.');
    }

    if (mode === 'create') {
      const rawVideo = form.video.trim();
      const videoId = rawVideo ? videoIdFrom(rawVideo) : '';
      if (rawVideo && !videoId) {
        return setError('Please enter a valid YouTube video link or 11-character video ID.');
      }
      socket.emit('create_room', { username, videoId }, (data) => {
        if (data?.error) setError(data.error);
        else if (data) enterRoom(data);
      });
    } else {
      const cleanRoom = form.roomId.trim().toUpperCase();
      if (!cleanRoom || cleanRoom.length !== 6) {
        return setError('Please enter a valid 6-character room code.');
      }
      socket.emit('join_room', { username, roomId: cleanRoom }, (data) => {
        if (data?.error) setError(data.error);
        else if (data) enterRoom(data);
      });
    }
  };

  const leave = () => {
    if (room?.roomId) {
      socket?.emit('leave_room', { roomId: room.roomId });
    }
    sessionStorage.removeItem('syncspace-session');
    setSession(null);
    setRoom(null);
    if (window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.pathname);
    }
  };

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('syncspace-theme', next);
      return next;
    });
  };

  return (
    <div className={`app theme-${theme}`}>
      {room ? (
        <Room
          socket={socket}
          initial={room}
          leave={leave}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      ) : (
        <Landing
          form={form}
          setForm={setForm}
          error={error}
          setError={setError}
          enter={enter}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      )}
    </div>
  );
}

function Landing({ form, setForm, error, setError, enter, theme, toggleTheme }) {
  const initialRoomParam = useMemo(
    () => new URLSearchParams(window.location.search).get('room') || '',
    []
  );

  const [mode, setMode] = useState(() => (initialRoomParam ? 'join' : 'create'));

  const update = (key) => (e) => {
    if (error) setError('');
    const val = key === 'roomId' ? e.target.value.toUpperCase().slice(0, 6) : e.target.value;
    setForm((prev) => ({ ...prev, [key]: val }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    enter(mode);
  };

  return (
    <main className="landing">
      {/* 7. Background: Ambient Lighting & Abstract Collaboration/Sync Visual */}
      <div className="landing-ambient-bg" aria-hidden="true">
        <div className="ambient-glow glow-1"></div>
        <div className="ambient-glow glow-2"></div>
        <div className="ambient-pattern"></div>
        <div className="ambient-sync-viewport">
          <div className="ambient-viewport-header">
            <span className="viewport-dot"></span>
            <span className="viewport-dot"></span>
            <span className="viewport-dot"></span>
            <span className="viewport-pill">LIVE SYNC • 1080P</span>
          </div>
          <div className="ambient-viewport-body">
            <svg viewBox="0 0 280 90" fill="none" className="ambient-viewport-svg" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 45 C 50 10, 100 80, 140 45 C 180 10, 230 80, 270 45" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.25" strokeDasharray="4 4"/>
              <path d="M10 45 C 60 75, 90 20, 140 45 C 190 70, 220 20, 270 45" stroke="var(--accent)" strokeWidth="1.5" strokeOpacity="0.5"/>
              <circle cx="140" cy="45" r="4.5" fill="var(--accent)"/>
              <circle cx="140" cy="45" r="12" stroke="var(--accent)" strokeWidth="1" strokeOpacity="0.35"/>
            </svg>
          </div>
        </div>
      </div>

      <header className="landing-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
              <polygon points="10,8 15,11 10,14" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1" />
            </svg>
          </div>
          <span className="brand-title">SyncSpace</span>
        </div>

        <div className="header-meta">
          <div className="tagline-badge" aria-label="Watch together in sync">
            <span className="live-dot" aria-hidden="true"></span>
            <span className="tagline-copy">In sync</span>
          </div>
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
        </div>
      </header>

      <div className="landing-body">
        <section className="hero-section">
          <div className="hero-eyebrow">
            <span className="eyebrow-dash" aria-hidden="true"></span>
            <span>YOUR GROUP. ONE PLAYBACK.</span>
          </div>

          <h1 className="hero-headline">
            Press play.<br />
            <em className="headline-accent">Stay in sync.</em>
          </h1>

          <p className="hero-description">
            Create a room, invite your people, and watch YouTube together—with synchronized
            playback, live chat, and reactions.
          </p>

          <div className="feature-grid" aria-label="Feature list">
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              </span>
              <span>Host &amp; Moderator controls</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              </span>
              <span>Synchronized playback</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              </span>
              <span>Invite by link</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              </span>
              <span>Chat &amp; live reactions</span>
            </div>
          </div>
        </section>

        <section className="card-section" aria-label="Room actions">
          <div className="launch-card">
            <div className="form-mode-switch" role="tablist" aria-label="Room action">
              <button
                type="button"
                id="create-room-tab"
                role="tab"
                aria-selected={mode === 'create'}
                aria-controls="create-room-panel"
                className={mode === 'create' ? 'active' : ''}
                onClick={() => {
                  setMode('create');
                  if (error) setError('');
                }}
              >
                Create room
              </button>
              <button
                type="button"
                id="join-room-tab"
                role="tab"
                aria-selected={mode === 'join'}
                aria-controls="join-room-panel"
                className={mode === 'join' ? 'active' : ''}
                onClick={() => {
                  setMode('join');
                  if (error) setError('');
                }}
              >
                Join room
              </button>
            </div>

            {initialRoomParam && mode === 'join' && (
              <div className="shared-invite-banner" role="status">
                <span className="invite-emoji">🎉</span>
                <div className="invite-text">
                  <strong>Room invite detected:</strong> Room <code>{initialRoomParam}</code>
                </div>
              </div>
            )}

            {mode === 'create' ? (
              /* 5. Room Creation Form */
              <form
                id="create-room-panel"
                className="card-form"
                role="tabpanel"
                aria-labelledby="create-room-tab"
                onSubmit={handleSubmit}
                noValidate
              >
                <div className="form-group">
                  <label htmlFor="display-name" className="input-label">
                    Display name <span className="required-mark">*</span>
                  </label>
                  <input
                    id="display-name"
                    type="text"
                    autoComplete="nickname"
                    maxLength={24}
                    placeholder="Enter your display name"
                    value={form.username}
                    onChange={update('username')}
                    className="text-input"
                    required
                  />
                  <p className="input-caption">
                    You will enter as the Host with moderation rights.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="video-url" className="input-label">
                    YouTube URL or Video ID <span className="optional-tag">(optional)</span>
                  </label>
                  <input
                    id="video-url"
                    type="text"
                    placeholder="Paste a YouTube URL or video ID"
                    value={form.video}
                    onChange={update('video')}
                    className="text-input"
                  />
                  <p className="input-caption">
                    Start with a video immediately, or leave it blank to choose one inside.
                  </p>
                </div>

                {error && (
                  <div className="error-banner" role="alert">
                    <span className="error-icon" aria-hidden="true">⚠️</span>
                    <span className="error-text">{error}</span>
                  </div>
                )}

                <div className="card-actions-group">
                  <button className="primary-cta-btn" type="submit">
                    <span>Start a Watch Party</span>
                    <span className="btn-arrow" aria-hidden="true">→</span>
                  </button>
                </div>
              </form>
            ) : (
              /* Room Joining Form */
              <form
                id="join-room-panel"
                className="card-form"
                role="tabpanel"
                aria-labelledby="join-room-tab"
                onSubmit={handleSubmit}
                noValidate
              >
                <div className="form-group">
                  <label htmlFor="display-name" className="input-label">
                    Display name <span className="required-mark">*</span>
                  </label>
                  <input
                    id="display-name"
                    type="text"
                    autoComplete="nickname"
                    maxLength={24}
                    placeholder="Enter your display name"
                    value={form.username}
                    onChange={update('username')}
                    className="text-input"
                    required
                  />
                  <p className="input-caption">
                    Shown in the participant roster and chat.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="room-code" className="input-label">
                    Room code <span className="required-mark">*</span>
                  </label>
                  <input
                    id="room-code"
                    type="text"
                    placeholder="6-CHARACTER CODE"
                    maxLength={6}
                    value={form.roomId}
                    onChange={update('roomId')}
                    className="text-input code-input"
                    autoCapitalize="characters"
                    required
                  />
                  <p className="input-caption">
                    Enter the 6-character code from your host or invitation link.
                  </p>
                </div>

                {error && (
                  <div className="error-banner" role="alert">
                    <span className="error-icon" aria-hidden="true">⚠️</span>
                    <span className="error-text">{error}</span>
                  </div>
                )}

                <div className="card-actions-group">
                  <button className="primary-cta-btn" type="submit">
                    <span>Join Room</span>
                    <span className="btn-arrow" aria-hidden="true">→</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      </div>

      <footer className="landing-footer">
        <div className="footer-wrapper">
          <p className="footer-line">Bring your people. Press play.</p>
          <p className="footer-line footer-subline">A shared YouTube room with chat and reactions.</p>
        </div>
      </footer>
    </main>
  );
}
