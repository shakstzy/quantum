import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';
import { z } from 'zod';

export const clipPropsSchema = z.object({
  videoSrc: z.string(),
  durationSec: z.number(),
  faceTrack: z.array(z.object({
    t: z.number(),
    cx: z.number(),
    cy: z.number(),
    w: z.number(),
    h: z.number(),
  })).default([]),
  captions: z.array(z.object({
    word: z.string(),
    start: z.number(),
    end: z.number(),
  })).default([]),
  hook: z.string().default(''),
});

export type ClipProps = z.infer<typeof clipPropsSchema>;

export const defaultProps: ClipProps = {
  videoSrc: '',
  durationSec: 30,
  faceTrack: [],
  captions: [],
  hook: '',
};

function pickFaceAt(track: ClipProps['faceTrack'], t: number) {
  if (track.length === 0) {
    return { cx: 0.5, cy: 0.5 };
  }
  // Find nearest by t (track is sorted by t). cx/cy are pixel-space; normalize via track.w/track.h.
  let best = track[0];
  for (const f of track) {
    if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  }
  const nx = best.w ? best.cx / best.w : 0.5;
  const ny = best.h ? best.cy / best.h : 0.5;
  return { cx: Math.max(0.1, Math.min(0.9, nx)), cy: Math.max(0.1, Math.min(0.9, ny)) };
}

function activeWords(captions: ClipProps['captions'], t: number, lookback = 0.4) {
  const words = captions.filter((w) => w.start <= t && w.end + lookback >= t);
  if (words.length === 0) return '';
  return words.slice(-4).map((w) => w.word).join(' ').trim();
}

export const ClipComposition: React.FC<ClipProps> = ({
  videoSrc,
  durationSec,
  faceTrack,
  captions,
  hook,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const { cx, cy } = pickFaceAt(faceTrack, t);

  const captionText = activeWords(captions, t).toUpperCase();
  const showHook = hook && t < 3.0;

  // 9:16 crop strategy: zoom 1.6x and translate to keep face near horizontal center,
  // upper-third vertical so captions sit beneath without covering the speaker.
  const scale = 1.6;
  const offsetX = (0.5 - cx) * 100;
  const offsetY = (0.35 - cy) * 100;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            transform: `scale(${scale}) translate(${offsetX}%, ${offsetY}%)`,
            transformOrigin: 'center center',
          }}
        >
          <OffthreadVideo
            src={
              videoSrc.startsWith('http://') || videoSrc.startsWith('https://')
                ? videoSrc
                : staticFile(videoSrc)
            }
            muted={false}
          />
        </div>
      </AbsoluteFill>

      {showHook ? (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 140 }}>
          <div
            style={{
              maxWidth: '88%',
              padding: '24px 32px',
              borderRadius: 24,
              background: 'rgba(0,0,0,0.65)',
              color: '#FFF200',
              fontSize: 64,
              fontWeight: 900,
              lineHeight: 1.1,
              fontFamily: 'Inter, Helvetica, Arial, sans-serif',
              textAlign: 'center',
              textShadow: '0 4px 16px rgba(0,0,0,0.6)',
            }}
          >
            {hook}
          </div>
        </AbsoluteFill>
      ) : null}

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 240 }}>
        {captionText ? (
          <div
            style={{
              maxWidth: '90%',
              padding: '20px 28px',
              borderRadius: 16,
              background: 'rgba(0,0,0,0.55)',
              color: 'white',
              fontSize: 78,
              fontWeight: 900,
              lineHeight: 1.05,
              letterSpacing: 0.5,
              fontFamily: 'Inter, Helvetica, Arial, sans-serif',
              textAlign: 'center',
              textShadow: '0 6px 20px rgba(0,0,0,0.8)',
            }}
          >
            {captionText}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
