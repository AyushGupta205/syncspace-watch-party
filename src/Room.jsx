import { useEffect, useMemo, useRef, useState } from 'react';
import { videoIdFrom } from './videoId.js';
import { YouTubePlayer } from './YouTubePlayer.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';

export function Room({ socket, initial, leave, theme, toggleTheme }) {
  const [state, setState] = useState(initial.state);
  const [actualPlaying, setActualPlaying] = useState(initial.state.isPlaying);
  const [people, setPeople] = useState(initial.participants);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [chatError, setChatError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(initial.state.currentTime || 0);
  const [copied, setCopied] = useState(false);
  const [isChangingVideo, setIsChangingVideo] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [reactions, setReactions] = useState([]);
  const [pendingPlaybackRequests, setPendingPlaybackRequests] = useState(
    initial.pendingPlaybackRequests || []
  );
  const [showPlaybackRequestForm, setShowPlaybackRequestForm] = useState(false);
  const [requestedAction, setRequestedAction] = useState('pause');
  const [requestedValue, setRequestedValue] = useState('');
  const [requestError, setRequestError] = useState('');
  const [requestStatus, setRequestStatus] = useState('');
  const [requestingPlayback, setRequestingPlayback] = useState(false);
  const [videoInput, setVideoInput] = useState(
    initial.state.videoId ? `https://www.youtube.com/watch?v=${initial.state.videoId}` : ''
  );

  // Accurate connection and synchronization status tracking
  const [syncStatus, setSyncStatus] = useState(() => (socket?.connected ? 'in_sync' : 'connecting'));
  const messagesEndRef = useRef(null);
  const syncTimeoutRef = useRef(null);
  const playerRef = useRef(null);
  const stateAnchorRef = useRef({ receivedAt: Date.now() });
  const revisionRef = useRef(initial.state.revision || 0);

  const self = useMemo(
    () => people.find((p) => p.id === initial.self.id) || initial.self,
    [people, initial.self]
  );
  const canControl = ['host', 'moderator'].includes(self.role);

  useEffect(() => {
    stateAnchorRef.current.receivedAt = Date.now();
    revisionRef.current = initial.state.revision || 0;
    setState(initial.state);
    setActualPlaying(initial.state.isPlaying);
    setPeople(initial.participants);
    setPendingPlaybackRequests(initial.pendingPlaybackRequests || []);
    setCurrentTime(initial.state.currentTime || 0);
    setVideoInput(
      initial.state.videoId ? `https://www.youtube.com/watch?v=${initial.state.videoId}` : ''
    );
  }, [initial]);

  useEffect(() => {
    setActualPlaying(state.isPlaying);
  }, [state.isPlaying]);

  const isVideoPlaying = actualPlaying ?? state.isPlaying;

  // Sync scrubber current time with player tick
  useEffect(() => {
    let timer;
    if (state.isPlaying) {
      timer = setInterval(() => {
        if (playerRef.current?.getCurrentTime) {
          const t = playerRef.current.getCurrentTime();
          setCurrentTime(t);
        }
      }, 500);
    } else {
      setCurrentTime(state.currentTime);
    }
    return () => clearInterval(timer);
  }, [state.isPlaying, state.currentTime]);

  // Socket connection and synchronization state listeners
  useEffect(() => {
    if (!socket) return;

    const onConnect = () => {
      setSyncStatus('connected');
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        setSyncStatus('in_sync');
      }, 400);
    };

    const onDisconnect = () => {
      setSyncStatus('connection_lost');
    };

    const onConnectError = () => {
      setSyncStatus('reconnecting');
    };

    const onSyncState = (next) => {
      if (Number.isSafeInteger(next?.revision) && next.revision <= revisionRef.current) return;
      if (Number.isSafeInteger(next?.revision)) revisionRef.current = next.revision;
      setSyncStatus('synchronizing');
      stateAnchorRef.current.receivedAt = Date.now();
      setState((old) => ({ ...old, ...next }));
      if (next.currentTime !== undefined) {
        setCurrentTime(next.currentTime);
      }
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        if (socket?.connected) {
          setSyncStatus('in_sync');
        }
      }, 500);
    };

    const onUserJoined = (data) => {
      if (data?.participant) {
        setPeople((old) =>
          old.some((person) => person.id === data.participant.id)
            ? old
            : [...old, data.participant]
        );
      }
      setMessages((old) => [
        ...old.slice(-199),
        {
          id: `sys-join-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'A participant'} joined the room`,
          time: Date.now(),
        },
      ]);
    };

    const onUserLeft = (data) => {
      setPeople((old) => old.filter((person) => person.id !== data.userId));
      setMessages((old) => [
        ...old.slice(-199),
        {
          id: `sys-leave-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'A participant'} left the room`,
          time: Date.now(),
        },
      ]);
    };

    const onParticipantDisconnected = (data) => {
      setPeople((old) =>
        old.map((person) =>
          person.id === data.userId ? { ...person, connected: false } : person
        )
      );
    };

    const onParticipantRemoved = (data) => {
      setPeople((old) => old.filter((person) => person.id !== data.userId));
    };

    const onPlaybackChangeRequested = (request) => {
      setPendingPlaybackRequests((old) =>
        old.some((item) => item.id === request.id) ? old : [...old, request]
      );
    };

    const onPlaybackRequestResolved = (data) => {
      setPendingPlaybackRequests((old) => old.filter((request) => request.id !== data.requestId));
    };

    const onPendingPlaybackRequests = (requests) => {
      setPendingPlaybackRequests(Array.isArray(requests) ? requests : []);
    };

    const onPlaybackRequestResult = (data) => {
      setRequestingPlayback(false);
      setRequestStatus(
        data.decision === 'approve'
          ? 'Your request was approved.'
          : data.decision === 'reject'
          ? 'Your request was declined.'
          : 'Your request expired or was cancelled.'
      );
    };

    const onHostChanged = (data) => {
      setMessages((old) => [
        ...old.slice(-199),
        {
          id: `sys-host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'A participant'} is now the Host`,
          time: Date.now(),
        },
      ]);
    };

    const onRoleAssigned = (data) => {
      setMessages((old) => [
        ...old.slice(-199),
        {
          id: `sys-role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          isSystem: true,
          text: `${data.username || 'User'} is now ${data.role === 'host' ? 'the Host' : data.role === 'moderator' ? 'a Moderator' : 'a Participant'}`,
          time: Date.now(),
        },
      ]);
    };

    const onActionRejected = (data) => {
      setPlayerError(data.message || data.error || 'Action rejected');
    };

    const onReaction = (data) => {
      if (!data?.emoji) return;
      const rx = {
        id: data.id || `rx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        emoji: data.emoji,
        username: data.username || 'User',
        left: 15 + Math.random() * 70,
      };
      setReactions((prev) => [...prev.slice(-12), rx]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== rx.id));
      }, 2600);
    };

    const onChatRateLimited = (data) => {
      setChatError(data?.error || 'Sending messages too fast.');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('sync_state', onSyncState);
    socket.on('participants_updated', setPeople);
    socket.on('user_joined', onUserJoined);
    socket.on('user_left', onUserLeft);
    socket.on('participant_disconnected', onParticipantDisconnected);
    socket.on('participant_removed', onParticipantRemoved);
    socket.on('playback_change_requested', onPlaybackChangeRequested);
    socket.on('playback_request_resolved', onPlaybackRequestResolved);
    socket.on('pending_playback_requests', onPendingPlaybackRequests);
    socket.on('playback_request_result', onPlaybackRequestResult);
    socket.on('role_assigned', onRoleAssigned);
    socket.on('host_changed', onHostChanged);
    socket.on('action_rejected', onActionRejected);
    socket.on('reaction', onReaction);
    socket.on('chat_rate_limited', onChatRateLimited);
    socket.on('chat_message', (m) => {
      setMessages((old) => [...old.slice(-199), m]);
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('sync_state', onSyncState);
      socket.off('participants_updated', setPeople);
      socket.off('user_joined', onUserJoined);
      socket.off('user_left', onUserLeft);
      socket.off('participant_disconnected', onParticipantDisconnected);
      socket.off('participant_removed', onParticipantRemoved);
      socket.off('playback_change_requested', onPlaybackChangeRequested);
      socket.off('playback_request_resolved', onPlaybackRequestResolved);
      socket.off('pending_playback_requests', onPendingPlaybackRequests);
      socket.off('playback_request_result', onPlaybackRequestResult);
      socket.off('role_assigned', onRoleAssigned);
      socket.off('host_changed', onHostChanged);
      socket.off('action_rejected', onActionRejected);
      socket.off('reaction', onReaction);
      socket.off('chat_rate_limited', onChatRateLimited);
      socket.off('chat_message');
      clearTimeout(syncTimeoutRef.current);
    };
  }, [socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Playback control routing through backend-authorized socket events
  const playback = (type, time = state.currentTime) => {
    if (!canControl || !socket?.connected) return;
    setSyncStatus('synchronizing');
    socket.emit('playback', { roomId: initial.roomId, type, time });
  };

  const handlePlayPause = () => {
    const curTime = playerRef.current?.getCurrentTime?.() ?? state.currentTime;
    playback(isVideoPlaying ? 'pause' : 'play', curTime);
  };

  const sendReaction = (emoji) => {
    if (!socket?.connected) return;
    socket.emit('reaction', { roomId: initial.roomId, emoji });
  };

  const handleSeek = (delta) => {
    const curTime = playerRef.current?.getCurrentTime?.() ?? state.currentTime;
    const maxDur = duration || playerRef.current?.getDuration?.() || 86400;
    const target = Math.max(0, Math.min(maxDur, curTime + delta));
    setCurrentTime(target);
    playback('seek', target);
  };

  const changeVideo = (e) => {
    e?.preventDefault();
    if (!canControl) return;
    if (!socket?.connected) {
      setPlayerError('Cannot change video while disconnected from the server.');
      return;
    }
    const id = videoIdFrom(videoInput);
    if (id) {
      setPlayerError('');
      setSyncStatus('synchronizing');
      socket.emit('playback', { roomId: initial.roomId, type: 'video', videoId: id });
      setIsChangingVideo(false);
    } else {
      setPlayerError('Please enter a valid YouTube URL (Shorts, youtu.be, watch, embed) or an 11-character video ID.');
    }
  };

  const requestPlaybackChange = (e) => {
    e?.preventDefault();
    if (canControl || !socket?.connected || requestingPlayback) return;
    setRequestError('');
    setRequestStatus('');

    let request = { type: requestedAction };
    if (requestedAction === 'play' || requestedAction === 'pause') {
      request.time = playerRef.current?.getCurrentTime?.() ?? currentTime;
    } else if (requestedAction === 'seek') {
      const time = Number(requestedValue);
      if (!requestedValue.trim() || !Number.isFinite(time) || time < 0 || time > 86400) {
        setRequestError('Enter a playback position between 0 and 86400 seconds.');
        return;
      }
      request.time = time;
    } else {
      const videoId = videoIdFrom(requestedValue);
      if (!videoId) {
        setRequestError('Enter a valid YouTube URL or 11-character video ID.');
        return;
      }
      request = { type: 'video', videoId };
    }

    setRequestingPlayback(true);
    socket.emit('request_playback_change', { roomId: initial.roomId, ...request }, (result) => {
      setRequestingPlayback(false);
      if (result?.error) {
        setRequestError(result.error);
        return;
      }
      setRequestStatus('Request sent to the Host and Moderators.');
      setShowPlaybackRequestForm(false);
      setRequestedValue('');
    });
  };

  const resolvePlaybackRequest = (request, decision) => {
    if (!canControl || !socket?.connected) return;
    socket.emit('resolve_playback_request', {
      roomId: initial.roomId,
      requestId: request.id,
      decision,
    });
  };

  const sendChat = (e) => {
    e?.preventDefault();
    if (!socket?.connected) {
      setChatError('Cannot send message: disconnected from server.');
      return;
    }
    const cleanText = text.trim();
    if (!cleanText) return;
    if (chatError) setChatError('');
    socket.emit('chat', { roomId: initial.roomId, text: cleanText });
    setText('');
  };

  const copy = () => {
    const url = `${window.location.origin}?room=${initial.roomId}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const statusLabels = {
    connecting: 'Connecting…',
    connected: 'Connected',
    synchronizing: 'Synchronizing…',
    in_sync: 'In sync',
    reconnecting: 'Reconnecting…',
    connection_lost: 'Connection lost',
  };

  const participantCount = people.length;
  const participantWording = `${participantCount} ${participantCount === 1 ? 'participant' : 'participants'}`;

  return (
    <main className="room-shell">
      {/* Ambient background lighting for Watch Room */}
      <div className="room-ambient-bg" aria-hidden="true">
        <div className="ambient-glow room-glow-1"></div>
        <div className="ambient-glow room-glow-2"></div>
        <div className="ambient-pattern"></div>
      </div>

      {/* 1. Room Header */}
      <header className="room-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
              <polygon points="10,8 15,11 10,14" fill="var(--accent)" stroke="var(--accent)" strokeWidth="1" />
            </svg>
          </div>
          <span className="brand-title">SyncSpace</span>
        </div>

        {/* Room Code Display: format "ROOM 1K9CJJ" with separate Copy Link button */}
        <div className="room-code-group" aria-label="Room details">
          <div className="room-code-pill">
            <span className="code-prefix">ROOM</span>
            <strong className="code-string">{initial.roomId}</strong>
          </div>
          <button
            type="button"
            className="copy-link-btn"
            onClick={copy}
            aria-label="Copy shareable room URL"
            title="Copy complete room URL"
          >
            <span className="copy-icon" aria-hidden="true">
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              )}
            </span>
            <span>{copied ? 'Link Copied' : 'Copy Link'}</span>
          </button>
        </div>

        {/* Header Right Actions: Theme Toggle clearly separated from Leave Room button */}
        <div className="header-right-group">
          <div className="theme-toggle-slot">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          </div>
          <div className="header-slot-divider" aria-hidden="true"></div>
          <button
            type="button"
            className="leave-room-btn"
            onClick={() => setShowLeaveModal(true)}
            title="Leave watch party and return to landing"
            aria-label="Leave watch party"
          >
            Leave Room
          </button>
        </div>
      </header>

      {/* Leave Room Confirmation Dialog */}
      {showLeaveModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="leave-modal-title">
          <div className="modal-dialog">
            <div className="modal-header">
              <span className="modal-warning-icon" aria-hidden="true">🚪</span>
              <h3 id="leave-modal-title">Leave Watch Party?</h3>
            </div>
            <p className="modal-body">
              Are you sure you want to leave room <strong>{initial.roomId}</strong>? You can rejoin anytime using the room code or invite link.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setShowLeaveModal(false)}
                autoFocus
              >
                Stay in Room
              </button>
              <button
                type="button"
                className="modal-confirm-btn"
                onClick={() => {
                  setShowLeaveModal(false);
                  leave();
                }}
              >
                Yes, Leave Room
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2-Column Responsive Layout */}
      <div className="room-layout">
        {/* Main Watch Area */}
        <section className="watch-section">
          {/* 2. YouTube Video Player */}
          <div className="video-container" aria-label="YouTube Video Player">
            {state.videoId ? (
              <YouTubePlayer
                state={state}
                stateAnchorRef={stateAnchorRef}
                playerRef={playerRef}
                canControl={canControl}
                onSharedPlayback={playback}
                onTitleChange={setVideoTitle}
                onDurationChange={setDuration}
                onPlayerStateChange={(isPlaying) => setActualPlaying(isPlaying)}
                onError={(errText) => setPlayerError(errText)}
              />
            ) : (
              <div className="empty-player">
                <div className="empty-icon" aria-hidden="true">◉</div>
                <h2>Choose a video to start</h2>
                <p>Paste any YouTube URL or 11-character video ID below to start synchronized playback.</p>
              </div>
            )}

            {/* Real-time synchronized floating reactions */}
            {reactions.length > 0 && (
              <div className="reactions-overlay" aria-hidden="true">
                {reactions.map((r) => (
                  <div key={r.id} className="floating-reaction" style={{ left: `${r.left}%` }}>
                    <span className="reaction-emoji">{r.emoji}</span>
                    <span className="reaction-username">{r.username}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Video Information Section: Playback Status on its own line above Video Title */}
          {state.videoId && (
            <div className="video-info-section">
              <div className="video-status-row">
                <span className={`playback-status-pill ${isVideoPlaying ? 'status-playing' : 'status-paused'}`}>
                  <span className="playback-status-dot" aria-hidden="true"></span>
                  <strong>{isVideoPlaying ? 'PLAYING' : 'PAUSED'}</strong>
                </span>
              </div>
              <h3 className="video-title-heading">
                {videoTitle || `YouTube Video (${state.videoId})`}
              </h3>
            </div>
          )}

          {/* Playback Error Alert */}
          {playerError && (
            <div className="room-error-alert" role="alert">
              <span className="error-text">⚠️ {playerError}</span>
              <button
                type="button"
                className="dismiss-error-btn"
                onClick={() => setPlayerError('')}
                aria-label="Dismiss playback error"
              >
                ✕
              </button>
            </div>
          )}

          {/* 4. Playback Controls Toolbar: −10s, +10s, Change Video */}
          <div className="controls-toolbar" role="toolbar" aria-label="Room playback controls">
            {/* Real derived synchronization status */}
            <div
              className={`sync-status-indicator status-${syncStatus}`}
              title={`Connection & Sync Status: ${statusLabels[syncStatus]}`}
              role="status"
              aria-live="polite"
            >
              <span className="sync-status-dot" aria-hidden="true"></span>
              <span className="sync-status-label">{statusLabels[syncStatus]}</span>
            </div>

            {/* Additional Custom Controls: -10s, +10s, Change Video */}
            <div className="toolbar-buttons">
              {canControl ? (
                <>
                  <button
                    type="button"
                    className="toolbar-btn primary-action-btn"
                    disabled={!state.videoId || !socket?.connected}
                    onClick={handlePlayPause}
                    aria-label={isVideoPlaying ? 'Pause synchronized playback' : 'Play synchronized playback'}
                  >
                    {isVideoPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn secondary-action-btn seek-btn"
                    disabled={!state.videoId || !socket?.connected}
                    onClick={() => handleSeek(-10)}
                    aria-label="Rewind 10 seconds"
                    title="Rewind 10 seconds (−10s)"
                  >
                    <span className="btn-icon" aria-hidden="true">⏪</span>
                    <span>−10s</span>
                  </button>

                  <button
                    type="button"
                    className="toolbar-btn secondary-action-btn seek-btn"
                    disabled={!state.videoId || !socket?.connected}
                    onClick={() => handleSeek(10)}
                    aria-label="Forward 10 seconds"
                    title="Forward 10 seconds (+10s)"
                  >
                    <span className="btn-icon" aria-hidden="true">⏩</span>
                    <span>+10s</span>
                  </button>

                  <button
                    type="button"
                    className={`toolbar-btn change-video-toggle-btn ${isChangingVideo ? 'active' : ''}`}
                    disabled={!socket?.connected}
                    onClick={() => setIsChangingVideo((prev) => !prev)}
                    aria-expanded={isChangingVideo}
                    aria-label="Toggle change video input"
                    title="Change room video"
                  >
                    <span className="btn-icon" aria-hidden="true">📺</span>
                    <span>Change Video</span>
                  </button>
                </>
              ) : (
                <div className="participant-control-notice">
                  <span>🔒 Playback changes require Host or Moderator approval.</span>
                  <button
                    type="button"
                    className="toolbar-btn secondary-action-btn"
                    disabled={!socket?.connected || requestingPlayback}
                    onClick={() => {
                      setRequestError('');
                      setRequestStatus('');
                      setShowPlaybackRequestForm((shown) => !shown);
                    }}
                    aria-expanded={showPlaybackRequestForm}
                  >
                    Request a change
                  </button>
                </div>
              )}
            </div>
          </div>

          {!canControl && showPlaybackRequestForm && (
            <form className="playback-request-panel" onSubmit={requestPlaybackChange}>
              <label>
                Change to request
                <select
                  value={requestedAction}
                  onChange={(event) => {
                    setRequestedAction(event.target.value);
                    setRequestError('');
                  }}
                  aria-label="Change to request"
                >
                  <option value="play">Play</option>
                  <option value="pause">Pause</option>
                  <option value="seek">Seek</option>
                  <option value="video">Change video</option>
                </select>
              </label>
              {(requestedAction === 'seek' || requestedAction === 'video') && (
                <label>
                  {requestedAction === 'seek' ? 'Position in seconds' : 'YouTube URL or video ID'}
                  <input
                    type={requestedAction === 'seek' ? 'number' : 'text'}
                    min={requestedAction === 'seek' ? '0' : undefined}
                    max={requestedAction === 'seek' ? '86400' : undefined}
                    step={requestedAction === 'seek' ? '0.1' : undefined}
                    value={requestedValue}
                    onChange={(event) => setRequestedValue(event.target.value)}
                    aria-label={requestedAction === 'seek' ? 'Position in seconds' : 'Requested YouTube video'}
                    required
                  />
                </label>
              )}
              {requestError && <p className="request-error" role="alert">{requestError}</p>}
              <div className="request-panel-actions">
                <button type="submit" disabled={!socket?.connected || requestingPlayback}>
                  {requestingPlayback ? 'Sending…' : 'Send request'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPlaybackRequestForm(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {requestStatus && !canControl && <p className="request-status" role="status">{requestStatus}</p>}

          {/* Expandable Change Video Panel */}
          {canControl && isChangingVideo && (
            <form className="change-video-panel" onSubmit={changeVideo}>
              <div className="change-input-wrap">
                <input
                  type="text"
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                  placeholder="Paste YouTube link (watch, shorts, embed, youtu.be, or video ID)..."
                  className="change-video-text-input"
                  autoFocus
                />
              </div>
              <div className="change-actions-wrap">
                <button type="submit" className="confirm-change-btn">
                  Load Video
                </button>
                <button
                  type="button"
                  className="cancel-change-btn"
                  onClick={() => setIsChangingVideo(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {canControl && pendingPlaybackRequests.length > 0 && (
            <section className="playback-requests-panel" aria-label="Pending playback requests">
              <h3>Playback requests</h3>
              {pendingPlaybackRequests.map((request) => {
                const action = request.action;
                const description =
                  action.type === 'video'
                    ? `change video to ${action.videoId}`
                    : action.type === 'seek'
                    ? `seek to ${action.time} seconds`
                    : action.type === 'play'
                    ? 'play the video'
                    : 'pause the video';
                return (
                  <div className="playback-request-row" key={request.id}>
                    <span><strong>{request.requesterName}</strong> requests to {description}.</span>
                    <button
                      type="button"
                      onClick={() => resolvePlaybackRequest(request, 'approve')}
                      disabled={!socket?.connected}
                      aria-label={`Approve playback request from ${request.requesterName}`}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => resolvePlaybackRequest(request, 'reject')}
                      disabled={!socket?.connected}
                      aria-label={`Decline playback request from ${request.requesterName}`}
                    >
                      Decline
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </section>

        {/* Sidebar: 4. Participants Panel & 5. Room Chat */}
        <aside className="room-sidebar">
          {/* 4. Participants Panel */}
          <section className="sidebar-card people-card" aria-label="Room participants">
            <div className="sidebar-card-header">
              <h2>Participants</h2>
              <span className="count-badge">{participantWording}</span>
            </div>

            <div className="people-list">
              {people.map((person) => {
                const isSelf = person.id === self.id;
                const isHost = self.role === 'host';
                return (
                  <div className="person-row" key={person.id}>
                    <div className="person-avatar" aria-hidden="true">
                      {person.username[0]?.toUpperCase() || '?'}
                    </div>

                    <div className="person-details">
                      <div className="person-name-line">
                        <strong className="person-name">{person.username}</strong>
                        {isSelf && <span className="you-indicator">You</span>}
                        <span className={`role-badge role-${person.role}`}>
                          {person.role === 'host' ? 'Host' : person.role === 'moderator' ? 'Moderator' : 'Participant'}
                        </span>
                      </div>
                    </div>

                    {isHost && !isSelf && (
                      <div className="host-management-actions">
                        <button
                          type="button"
                          className="role-action-btn"
                          disabled={!socket?.connected}
                          onClick={() =>
                            socket.emit('assign_role', {
                              roomId: initial.roomId,
                              userId: person.id,
                              role: person.role === 'moderator' ? 'participant' : 'moderator',
                            })
                          }
                          title={person.role === 'moderator' ? 'Demote to participant' : 'Promote to moderator'}
                        >
                          {person.role === 'moderator' ? 'Demote' : 'Make mod'}
                        </button>
                        <button
                          type="button"
                          className="role-action-btn transfer-action-btn"
                          disabled={!socket?.connected || !person.connected}
                          onClick={() =>
                            socket.emit('transfer_host', {
                              roomId: initial.roomId,
                              userId: person.id,
                            })
                          }
                          title={`Transfer host ownership to ${person.username}`}
                        >
                          Make Host
                        </button>
                        <button
                          type="button"
                          className="remove-action-btn"
                          disabled={!socket?.connected}
                          onClick={() =>
                            socket.emit('remove_participant', {
                              roomId: initial.roomId,
                              userId: person.id,
                            })
                          }
                          title={`Remove ${person.username} from room`}
                          aria-label={`Remove ${person.username}`}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 5. Room Chat Panel */}
          <section className="sidebar-card chat-card" aria-label="Room chat">
            <div className="sidebar-card-header chat-card-header">
              <div className="chat-header-title">
                <svg className="chat-title-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <h2>Room Chat</h2>
              </div>
              <div className="chat-header-status">
                {socket?.connected ? (
                  <span className="chat-live-badge" title="Chat live">
                    <span className="chat-live-dot" aria-hidden="true"></span>
                    <span>Live</span>
                  </span>
                ) : (
                  <span className="chat-offline-badge">Offline</span>
                )}
              </div>
            </div>

            <div className="chat-messages-container" aria-live="polite">
              {messages.length ? (
                messages.map((m) => {
                  if (m.isSystem) {
                    return (
                      <div className="chat-system-message" key={m.id}>
                        <span className="chat-system-text">{m.text}</span>
                      </div>
                    );
                  }
                  const isSelf = m.username?.toLowerCase() === self.username?.toLowerCase();
                  const timeFormatted = m.time
                    ? new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';
                  return (
                    <div
                      className={`chat-message-bubble ${isSelf ? 'bubble-self' : 'bubble-other'}`}
                      key={m.id}
                    >
                      <div className="message-header-line">
                        <strong className="message-sender">{isSelf ? 'You' : m.username}</strong>
                        {timeFormatted && <span className="message-timestamp">{timeFormatted}</span>}
                      </div>
                      <p className="message-text-content">{m.text}</p>
                    </div>
                  );
                })
              ) : (
                <div className="chat-empty-notice">
                  <div className="empty-chat-icon-ring" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                      <circle cx="9" cy="10" r="1" fill="currentColor"></circle>
                      <circle cx="12" cy="10" r="1" fill="currentColor"></circle>
                      <circle cx="15" cy="10" r="1" fill="currentColor"></circle>
                    </svg>
                  </div>
                  <strong className="empty-chat-lead">No messages yet</strong>
                  <p className="empty-chat-sub">Start the conversation! Send a message to everyone in this room.</p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Synchronized Emoji Reactions */}
            <div className="chat-reactions-toolbar" aria-label="Room reactions">
              {['🔥', '❤️', '😂', '👏', '🎉', '😮'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="quick-reaction-btn"
                  onClick={() => sendReaction(emoji)}
                  disabled={!socket?.connected}
                  title={`React with ${emoji}`}
                  aria-label={`Send reaction ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>

            <form className="chat-input-form" onSubmit={sendChat}>
              <div className="chat-input-wrapper">
                <textarea
                  rows={1}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    if (chatError) setChatError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendChat(e);
                    }
                  }}
                  placeholder={socket?.connected ? 'Type a message…' : 'Reconnecting to chat...'}
                  disabled={!socket?.connected}
                  className="chat-textarea-input"
                  maxLength={500}
                  aria-label="Type a message"
                />
              </div>
              <button
                type="submit"
                className="chat-send-action-btn"
                disabled={!socket?.connected || !text.trim()}
                aria-label="Send message"
                title="Send message (Enter)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            </form>
            {chatError && (
              <div className="chat-error-notice" role="alert">
                <span>⚠️ {chatError}</span>
              </div>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
