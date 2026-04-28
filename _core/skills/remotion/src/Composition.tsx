import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

export const DemoComposition = () => {
  const frame = useCurrentFrame();

  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const x = interpolate(frame, [0, 90], [-120, 120]);

  return (
    <AbsoluteFill
      style={{
        background: '#111827',
        color: 'white',
        fontFamily: 'Arial, Helvetica, sans-serif',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateX(${x}px)`,
          fontSize: 72,
          fontWeight: 700,
        }}
      >
        Remotion CLI OK
      </div>
    </AbsoluteFill>
  );
};
