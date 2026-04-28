import {Composition} from 'remotion';
import {DemoComposition} from './Composition';

export const RemotionRoot = () => {
  return (
    <Composition
      id="Demo"
      component={DemoComposition}
      durationInFrames={90}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
