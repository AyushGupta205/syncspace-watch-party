import { useEffect, useRef } from 'react';

export function YouTubePlayer({
  state,
  stateAnchorRef,
  playerRef,
  canControl,
  onSharedPlayback,
  onTitleChange,
  onDurationChange,
  onPlayerStateChange,
  onError,
}) {
  const mount = useRef(null);
  const player = useRef(null);
  const ready = useRef(false);
  const activeVideoId = useRef('');
  const latestState = useRef(state);
  latestState.current = state;
  const latestCanControl = useRef(canControl);
  latestCanControl.current = canControl;

  const apply = (next, detectLocalSeek = false) => {
    const instance = player.current;
    if (!ready.current || !instance) return;

    if (activeVideoId.current !== next.videoId) {
      activeVideoId.current = next.videoId;
      const elapsed = next.isPlaying
        ? Math.max(0, Date.now() - stateAnchorRef.current.receivedAt) / 1000
        : 0;
      const options = { videoId: next.videoId, startSeconds: next.currentTime + elapsed };
      if (next.isPlaying) {
        instance.loadVideoById(options);
      } else {
        instance.cueVideoById(options);
      }
      return;
    }

    const elapsed = next.isPlaying
      ? Math.max(0, Date.now() - stateAnchorRef.current.receivedAt) / 1000
      : 0;
    const expectedTime = next.currentTime + elapsed;
    const currentTime = instance.getCurrentTime?.() || 0;
    const playerState = instance.getPlayerState?.();
    if (Math.abs(currentTime - expectedTime) > 1.5) {
      if (
        detectLocalSeek &&
        latestCanControl.current &&
        (playerState === 1 || playerState === 2)
      ) {
        onSharedPlayback?.('seek', currentTime);
        return;
      }
      instance.seekTo(expectedTime, true);
    }

    if (next.isPlaying && playerState !== 1) {
      instance.playVideo();
    } else if (!next.isPlaying && playerState !== 2 && playerState !== 5) {
      instance.pauseVideo();
    }
  };

  useEffect(() => {
    const fetchMeta = (instance) => {
      try {
        const title = instance?.getVideoData?.()?.title;
        if (title) onTitleChange(title);
        const dur = instance?.getDuration?.();
        if (dur) onDurationChange?.(dur);
      } catch {
        // Player metadata is optional and may be unavailable before the video loads.
      }
    };

    const create = () => {
      if (!mount.current || player.current || !window.YT?.Player) return;
      player.current = new window.YT.Player(mount.current, {
        videoId: latestState.current.videoId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          fs: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            ready.current = true;
            onError?.('');
            if (playerRef) playerRef.current = event.target;
            const iframe = event.target?.getIframe?.();
            if (iframe) {
              iframe.style.pointerEvents = latestCanControl.current ? 'auto' : 'none';
              iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen');
              iframe.setAttribute('allowfullscreen', 'true');
            }
            fetchMeta(event.target);
            apply(latestState.current);
          },
          onStateChange: (event) => {
            fetchMeta(event.target);
            const instance = event.target;
            const curState = latestState.current;
            const hasControl = latestCanControl.current;

            if (event?.data === 1) {
              onPlayerStateChange?.(true);
              if (hasControl && !curState.isPlaying) {
                onSharedPlayback?.('play', instance.getCurrentTime?.() ?? curState.currentTime);
              } else if (!hasControl && !curState.isPlaying) {
                instance.pauseVideo();
              }
            } else if (event?.data === 2) {
              onPlayerStateChange?.(false);
              if (hasControl && curState.isPlaying) {
                onSharedPlayback?.('pause', instance.getCurrentTime?.() ?? curState.currentTime);
              } else if (!hasControl && curState.isPlaying) {
                instance.playVideo();
              }
            }
          },
          onError: (event) => {
            let errorText = 'YouTube encountered an error loading this video.';
            if (event?.data === 150 || event?.data === 101) {
              errorText = 'The video owner has disabled playback in embedded players. Please choose another public video.';
            } else if (event?.data === 100) {
              errorText = 'This video does not exist or has been removed.';
            } else if (event?.data === 2) {
              errorText = 'Invalid YouTube video ID or parameter.';
            } else if (event?.data === 5) {
              errorText = 'HTML5 player error. Please try another video or refresh.';
            }
            onError?.(errorText);
          },
        },
      });
      if (playerRef) playerRef.current = player.current;
    };

    const old = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      old?.();
      create();
    };

    if (window.YT?.Player) {
      create();
    } else if (!document.querySelector('script[data-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.dataset.youtubeApi = 'true';
      script.onerror = () => onError?.('Unable to load the YouTube player. Check your connection and try again.');
      document.head.appendChild(script);
    }

    return () => {
      window.onYouTubeIframeAPIReady = old;
      ready.current = false;
      player.current?.destroy();
      player.current = null;
      if (playerRef) playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const iframe = player.current?.getIframe?.();
    if (iframe) iframe.style.pointerEvents = canControl ? 'auto' : 'none';
  }, [canControl]);

  useEffect(() => {
    apply(state);
  }, [state.videoId, state.currentTime, state.isPlaying]);

  useEffect(() => {
    const timer = setInterval(() => apply(latestState.current, true), 2000);
    return () => clearInterval(timer);
  }, []);

  return <div className="youtube-player" ref={mount} />;
}
