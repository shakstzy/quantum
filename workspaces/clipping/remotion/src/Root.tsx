import { Composition } from 'remotion';
import { ClipComposition, defaultProps, clipPropsSchema } from './compositions/ClipComposition';

const FPS = 30;

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="ClipComposition"
        component={ClipComposition}
        durationInFrames={Math.round(defaultProps.durationSec * FPS)}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
        schema={clipPropsSchema}
        calculateMetadata={({ props }) => {
          const dur = Math.max(1, props.durationSec || defaultProps.durationSec);
          return {
            durationInFrames: Math.max(1, Math.round(dur * FPS)),
          };
        }}
      />
    </>
  );
};
